/** SDK 2.0 only preserves _meta; mirror OpenAI's tool-list extension on the wire. */
export function mirrorToolAuth(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || !("result" in payload)) return false;
  const result = (payload as {result?: {tools?: Array<Record<string, unknown>>}}).result;
  if (!Array.isArray(result?.tools)) return false;
  for (const tool of result.tools) {
    const meta = tool._meta as Record<string, unknown> | undefined;
    if (Array.isArray(meta?.securitySchemes)) tool.securitySchemes = meta.securitySchemes;
  }
  return true;
}
export async function mirrorToolAuthResponse(response: Response): Promise<Response> {
  const type = response.headers.get("content-type") ?? "";
  if (!response.ok) return response;
  const headers = new Headers(response.headers); headers.delete("content-length");
  if (type.includes("application/json")) {
    const payload: unknown = await response.clone().json();
    if (!mirrorToolAuth(payload)) return response;
    return new Response(JSON.stringify(payload), {status:response.status,headers});
  }
  if (!type.includes("text/event-stream") || !response.body) return response;
  const decoder = new TextDecoder(); const encoder = new TextEncoder(); let pending = "";
  function event(value: string): string {
    const lines = value.split(/\r?\n/);
    const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    try {
      const payload: unknown = JSON.parse(data);
      if (mirrorToolAuth(payload)) return [...lines.filter(line => !line.startsWith("data:")), `data: ${JSON.stringify(payload)}`].join("\n");
    } catch { /* Preserve non-JSON SSE events, comments and pings. */ }
    return value;
  }
  const stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, {stream:true});
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        controller.enqueue(encoder.encode(event(pending.slice(0,boundary.index))+"\n\n"));
        pending=pending.slice(boundary.index+boundary[0].length);
      }
      if (pending.length > 2*1024*1024) throw new Error("MCP_FRAME_TOO_LARGE");
    },
    flush(controller) { pending += decoder.decode(); if (pending) controller.enqueue(encoder.encode(event(pending))); },
  }));
  return new Response(stream, {status:response.status,headers});
}
