import { EventSource } from 'eventsource'
import WebSocket from 'ws'
import { configureEventSource } from '@arkade-os/sdk'

configureEventSource(url => new EventSource(url))
;(globalThis as any).EventSource = EventSource
;(globalThis as any).WebSocket = WebSocket
