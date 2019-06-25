import _ from 'lodash'
import concatStream from 'concat-stream'
import debugModule from 'debug'
import { IncomingMessage, ServerResponse } from 'http'
import minimatch from 'minimatch'
import { Readable } from 'stream'
import url from 'url'
// TODO: figure out the right way to make these types accessible in server and driver
import {
  CyHttpMessages,
  NetEventFrames,
  AnnotatedRouteMatcherOptions,
  RouteMatcherOptions,
  DICT_STRING_MATCHER_FIELDS,
  STRING_MATCHER_FIELDS,
  SERIALIZABLE_REQ_PROPS,
  SERIALIZABLE_RES_PROPS,
  StaticResponse,
} from '../../driver/src/cy/commands/net_stubbing'

interface BackendRoute {
  routeMatcher: RouteMatcherOptions
  handlerId?: string
  staticResponse?: StaticResponse
}

interface ProxyIncomingMessage extends IncomingMessage {
  proxiedUrl: string
  webSocket: boolean // TODO: populate
  requestId: string
}

const debug = debugModule('cypress:server:net_stubbing')

function _getAllStringMatcherFields(options) {
  return _.concat(
    _.filter(STRING_MATCHER_FIELDS, _.partial(_.has, options)),
    // add the nested DictStringMatcher values to the list of fields
    _.flatten(
      _.filter(
        DICT_STRING_MATCHER_FIELDS.map(field => {
          const value = options[field]

          if (value) {
            return _.keys(value).map(key => {
              return `${field}.${key}`
            })
          }

          return ''
        })
      )
    )
  )
}

function _restoreMatcherOptionsTypes(options: AnnotatedRouteMatcherOptions) {
  const stringMatcherFields = _getAllStringMatcherFields(options)

  const ret : RouteMatcherOptions = {}

  stringMatcherFields.forEach(field => {
    const obj = _.get(options, field)

    if (obj) {
      _.set(ret, field, obj.type === 'regex' ? new RegExp(obj.value) : obj.value)
    }
  })

  const noAnnotationRequiredFields = ['https', 'port', 'webSocket']
  _.extend(ret, _.pick(options, noAnnotationRequiredFields))

  return ret
}

// TODO: clear between specs
let routes : BackendRoute[] = []

function _onRouteAdded(options: NetEventFrames.AddRoute) {
  const routeMatcher = _restoreMatcherOptionsTypes(options.routeMatcher)

  debug('adding route %o', { routeMatcher, options })

  routes.push({
    routeMatcher,
    ..._.omit(options, 'routeMatcher')
  })
}

function _getRouteForRequest(req: ProxyIncomingMessage, prevRoute?: BackendRoute) {
  const possibleRoutes = prevRoute ? routes.slice(_.findIndex(routes, prevRoute) + 1) : routes
  return _.find(possibleRoutes, route => {
    return _doesRouteMatch(route.routeMatcher, req)
  })
}

export function _getMatchableForRequest(req) {
  let matchable : any = _.pick(req, ['headers', 'method', 'webSocket'])

  const authorization = req.headers['authorization']
  if (authorization) {
    const [mechanism, credentials] = authorization.split(' ', 2)
    if (mechanism && credentials && mechanism.toLowerCase() === 'basic') {
      const [username, password] = Buffer.from(credentials, 'base64').toString().split(':', 2)
      matchable.auth = { username, password }
    }
  }

  const proxiedUrl = url.parse(req.proxiedUrl, true)

  _.assign(matchable, _.pick(proxiedUrl, ['hostname', 'path', 'pathname', 'port', 'query']))

  matchable.url = req.proxiedUrl

  matchable.https = proxiedUrl.protocol && (proxiedUrl.protocol.indexOf('https') === 0)

  if (!matchable.port) {
    matchable.port = matchable.https ? 443 : 80
  }

  return matchable
}

/**
 * Returns `true` if `req` matches all supplied properties on `routeMatcher`, `false` otherwise.
 */
// TOOD: optimize to short-circuit on route not match
export function _doesRouteMatch(routeMatcher: RouteMatcherOptions, req: ProxyIncomingMessage) {
  const matchable = _getMatchableForRequest(req)

  let match = true

  // get a list of all the fields which exist where a rule needs to be succeed
  const stringMatcherFields = _getAllStringMatcherFields(routeMatcher)
  const booleanFields = _.filter(_.keys(routeMatcher), _.partial(_.includes, ['https', 'webSocket']))
  const numberFields = _.filter(_.keys(routeMatcher), _.partial(_.includes, ['port']))

  stringMatcherFields.forEach((field) => {
    const matcher = _.get(routeMatcher, field)
    let value = _.get(matchable, field, '')

    if (typeof value !== 'string') {
      value = String(value)
    }

    if (matcher.test) {
      // value is a regex
      match = match && matcher.test(value)
      return
    }

    if (field === 'url') {
      // for urls, check that it appears anywhere in the string
      if (value.includes(matcher)) {
        return
      }
    }

    match = match && minimatch(value, matcher, { matchBase: true })
  })

  booleanFields.forEach((field) => {
    const matcher = _.get(routeMatcher, field)
    const value = _.get(matchable, field)
    match = match && (matcher === value)
  })

  numberFields.forEach((field) => {
    const matcher = _.get(routeMatcher, field)
    const value = _.get(matchable, field)
    if (matcher.length) {
      // list of numbers, any one can match
      match = match && matcher.includes(value)
      return
    }
    match = match && (matcher === value)
  })

  debug('does route match? %o', { match, routeMatcher, req: _.pick(matchable, _.concat(stringMatcherFields, booleanFields, numberFields)) })

  return match
}

function _emit(socket: any, eventName: string, data: any) {
  debug('sending event to driver %o', { eventName, data })
  socket.toDriver('net:event', eventName, data)
}

function _sendStaticResponse(res: ServerResponse, staticResponse: StaticResponse) {
  if (staticResponse.destroySocket) {
    res.connection.destroy()
    res.destroy()
    return
  }

  if (staticResponse.headers) {
    _.keys(staticResponse.headers).forEach(key => {
      res.setHeader(key, (<StaticResponse>staticResponse.headers)[key])
    })
  }

  if (staticResponse.body) {
    res.write(staticResponse.body)
  }

  res.statusCode = staticResponse.statusCode || 200
  res.end()
}

export function onDriverEvent(socket: any, eventName: string, ...args: any[]) {
  debug('received driver event %o', { eventName, args })

  switch(eventName) {
    case 'route:added':
      _onRouteAdded(<NetEventFrames.AddRoute>args[0])
      break
    case 'clear:routes':
      // TODO: initiate this from an existing point in the server, not a new request
      requests = {}
      routes = []
      break
    case 'http:request:continue':
      _onRequestContinue(<NetEventFrames.HttpRequestContinue>args[0], socket)
      break
    case 'http:response:continue':
      _onResponseContinue(<NetEventFrames.HttpResponseContinue>args[0])
      break
    case 'ws:connect:continue':
      break
    case 'ws:frame:outgoing:continue':
      break
    case 'ws:frame:incoming:continue':
      break
  }
}

interface BackendRequest {
  requestId: string
  route: BackendRoute
  /**
   * A callback that can be used to make the request go outbound.
   */
  continueRequest: Function
  /**
   * A callback that can be used to send the response through the proxy.
   */
  continueResponse?: Function
  req: ProxyIncomingMessage
  res: ServerResponse
  sendResponseToDriver?: boolean
}

// TODO: clear on each test
let requests : { [key: string]: BackendRequest } = {}

export function onProxiedRequest(project: any, req: ProxyIncomingMessage, res: ServerResponse, cb: Function) {
  const route = _getRouteForRequest(req)

  if (!route) {
    return cb()
  }

  if (route.staticResponse) {
    _sendStaticResponse(res, route.staticResponse)
    return // don't call cb since we've satisfied the response here
  }

  const requestId = _.uniqueId('interceptedRequest')

  const request : BackendRequest = {
    requestId,
    route,
    continueRequest: cb,
    req,
    res
  }

  req.requestId = requestId

  requests[requestId] = request

  const frame : NetEventFrames.HttpRequestReceived = {
    routeHandlerId: route.handlerId!,
    requestId,
    req: _.extend(_.pick(req, SERIALIZABLE_REQ_PROPS), {
      url: req.proxiedUrl,
      // body: "not implemented... yet" // TODO: buffer the body here with the stream-buffer from net-retries
    }) as CyHttpMessages.IncomingRequest
  }

  req.pipe(concatStream(reqBody => {
    frame.req.body = reqBody.toString()
    _emit(project.server._socket, 'http:request:received', frame)
  }))
}

function _onRequestContinue(frame: NetEventFrames.HttpRequestContinue, socket: any) {
  const backendRequest = requests[frame.requestId]

  if (!backendRequest) {
    return
    // TODO
  }

  // modify the original paused request object using what the client returned
  _.assign(backendRequest.req, _.pick(frame.req, SERIALIZABLE_REQ_PROPS))

  if (frame.tryNextRoute) {
    // frame.req has been modified, now pass this to the next available route handler
    const prevRoute = _.find(routes, { handlerId: frame.routeHandlerId })

    const route = _getRouteForRequest(backendRequest.req, prevRoute)

    if (!route) {
      // no "next route" available, so just continue that bad boy
      backendRequest.continueRequest()
      return
    }

    if (route.staticResponse) {
      _sendStaticResponse(backendRequest.res, route.staticResponse)
      return
    }

    const nextFrame : NetEventFrames.HttpRequestReceived = {
      routeHandlerId: <string>route.handlerId,
      requestId: backendRequest.requestId,
      req: frame.req!
    }

    _emit(socket, 'http:request:received', nextFrame)

    return
  }

  if (frame.staticResponse) {
    _sendStaticResponse(backendRequest.res, frame.staticResponse)
    return
  }

  if (frame.hasResponseHandler) {
    backendRequest.sendResponseToDriver = true
  }

  backendRequest.continueRequest()
}

export function onProxiedResponse(project: any, req: ProxyIncomingMessage, resStream: Readable, incomingRes: IncomingMessage, cb: Function) {
  if (!req.requestId) {
    // original request was not intercepted, so response should not be either
    return
  }

  const backendRequest = requests[req.requestId]

  if (!backendRequest.sendResponseToDriver) {
    cb()
  }

  // this may get set back to `true` by another route
  backendRequest.sendResponseToDriver = false
  backendRequest.continueResponse = cb

  const frame : NetEventFrames.HttpResponseReceived = {
    routeHandlerId: backendRequest.route.handlerId!,
    requestId: backendRequest.requestId,
    res: _.extend(_.pick(incomingRes, SERIALIZABLE_RES_PROPS), {
      url: req.proxiedUrl,
    }) as CyHttpMessages.IncomingResponse
  }

  resStream.pipe(concatStream(resBody => {
    frame.res.body = resBody.toString()
    _emit(project.server._socket, 'http:response:received', frame)
  }))
}

function _onResponseContinue(frame: NetEventFrames.HttpResponseContinue) {
  const backendRequest = requests[frame.requestId]

  if (frame.staticResponse) {
    _sendStaticResponse(backendRequest.res, frame.staticResponse)
    return
  }

  // merge the changed response attributes with our response and continue
  _.assign(backendRequest.res, _.pick(frame.res, SERIALIZABLE_RES_PROPS))

  // TODO: do something with the changed body
  backendRequest.continueResponse!()
}
