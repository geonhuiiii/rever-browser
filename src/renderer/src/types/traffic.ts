export interface TrafficEntry {
  requestId: string
  url: string
  method: string
  resourceType: string
  status?: number
  mimeType?: string
  encodedDataLength?: number
  startedAt: number
  completedAt?: number
  /** set only for XHR/Fetch — links this entry to its ApiEndpoint bucket */
  endpointKey?: string
}

export interface ApiEndpoint {
  key: string
  origin: string
  host: string
  path: string
  method: string
  count: number
  lastRequestId: string
  lastSeen: number
  statuses: number[]
  auth: boolean
}

export type NetworkEvent =
  | {
      type: 'request'
      request_id: string
      url: string
      method: string
      resource_type: string
      timestamp: number
    }
  | {
      type: 'response'
      request_id: string
      status: number
      mime_type: string
      timestamp: number
    }
  | {
      type: 'finished'
      request_id: string
      encoded_data_length: number
      timestamp: number
    }
