import type {
  PoolOperationResponse, PoolPrepareRequest, PoolPreparedGame, PoolPublicResponse,
  PoolRevealResponse, PoolSubmitRequest,
} from 'arkade-coinflip/dist/pool-protocol.js'

const BASE_URL = process.env.VUE_APP_API_URL || ''

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BASE_URL}/api/pool${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(60_000),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) throw new Error(`Pool coordinator request failed (${response.status})`)
  return response.json()
}

export const fundedPoolApi = {
  get: (): Promise<PoolPublicResponse> => request(''),
  prepare: (body: PoolPrepareRequest): Promise<PoolPreparedGame> => request('/prepare', body),
  submit: (body: PoolSubmitRequest): Promise<PoolOperationResponse> => request('/submit', body),
  operation: (id: string): Promise<PoolOperationResponse> => request(`/operations/${encodeURIComponent(id)}`),
  reveal: (id: string, playerSecretHex: string): Promise<PoolRevealResponse> =>
    request(`/operations/${encodeURIComponent(id)}/reveal`, { playerSecretHex }),
}
