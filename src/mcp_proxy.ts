import 'dotenv/config';
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";

// Connection cache - target server URL as key
interface CachedConnection {
    sessionId: string;
    postUrl: string;
    baseUrl: string;
    ssePath: string;
    lastUsed: number;
    isHealthy: boolean;
    responsePromises: Map<string, { resolve: Function; reject: Function }>;
    sseReader?: ReadableStreamDefaultReader<Uint8Array>;
}

const connectionCache = new Map<string, CachedConnection>();

// Configuration
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
const API_KEY = process.env.MCP_PROXY_API_KEY || 'default-key';

// Cleanup old connections
setInterval(() => {
    const now = Date.now();
    let cleanedCount = 0;
    for (const [url, connection] of connectionCache.entries()) {
        if (now - connection.lastUsed > CACHE_TTL) {
            console.log(`[MCP-PROXY] Cleaning up expired connection: ${url}`);
            connectionCache.delete(url);
            cleanedCount++;
        }
    }
    if (cleanedCount > 0) {
        console.log(`[MCP-PROXY] Cleaned up ${cleanedCount} expired connections`);
    }
}, CLEANUP_INTERVAL);

// Extract target server from headers
function getTargetServer(req: IncomingMessage): string | null {
    const targetServer = req.headers['x-target-server'] as string;
    console.log('[MCP-PROXY] Request headers:', JSON.stringify(req.headers, null, 2));
    if (!targetServer) {
        console.log('[MCP-PROXY] Missing X-Target-Server header');
        return null;
    }
    console.log('[MCP-PROXY] Target server:', targetServer);
    return targetServer;
}

// Verify API key
function verifyApiKey(req: IncomingMessage): boolean {
    const auth = req.headers.authorization;
    console.log('[MCP-PROXY] Auth header:', auth ? 'present' : 'missing');
    if (!auth || !auth.startsWith('Bearer ')) {
        console.log('[MCP-PROXY] Missing or invalid Authorization header');
        return false;
    }

    const token = auth.substring(7);
    console.log('[MCP-PROXY] Expected API key:', API_KEY);
    console.log('[MCP-PROXY] Received API key:', token);
    console.log('[MCP-PROXY] API key validation:', token === API_KEY ? 'valid' : 'invalid');
    if (token !== API_KEY) {
        console.log('[MCP-PROXY] Invalid API key');
        return false;
    }

    return true;
}

// Parse SSE response to extract JSON
function parseSseResponse(sseText: string): any {
    console.log(`[MCP-PROXY] parseSseResponse called with:`, sseText.slice(0, 200) + '...');
    const dataLines = sseText
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .filter(s => s.length > 0);

    console.log(`[MCP-PROXY] SSE data lines:`, dataLines);

    if (dataLines.length === 0) {
        throw new Error('No data in SSE response');
    }

    // Use the last data line as the final JSON-RPC response
    const lastLine = dataLines[dataLines.length - 1];
    if (!lastLine) {
        throw new Error('No data in SSE response');
    }

    console.log(`[MCP-PROXY] Parsing last line:`, lastLine);
    try {
        const parsed = JSON.parse(lastLine);
        console.log(`[MCP-PROXY] Parsed JSON:`, JSON.stringify(parsed, null, 2));
        return parsed;
    } catch (e) {
        console.log(`[MCP-PROXY] Failed to parse last line, trying to join all data lines...`);
        // Try joining all data lines in case JSON was split across frames
        try {
            const joined = dataLines.join('');
            console.log(`[MCP-PROXY] Joined data lines:`, joined);
            const parsed = JSON.parse(joined);
            console.log(`[MCP-PROXY] Parsed joined JSON:`, JSON.stringify(parsed, null, 2));
            return parsed;
        } catch (e2) {
            console.log(`[MCP-PROXY] Failed to parse joined JSON:`, e2);
            throw new Error(`Failed to parse SSE JSON: ${e2}`);
        }
    }
}

// Forward request to target server via persistent SSE connection
async function forwardToTarget(targetServer: string, method: string, params: any, apiKey?: string): Promise<any> {
    console.log(`[MCP-PROXY] forwardToTarget called with:`, { targetServer, method, params, apiKey: apiKey ? 'present' : 'missing' });
    const connection = await getConnection(targetServer, apiKey);
    const requestId = Math.floor(Math.random() * 1000000).toString();

    // Create JSON-RPC request
    const request = {
        jsonrpc: '2.0',
        method: method,
        params: params,
        id: requestId
    };

    console.log(`[MCP-PROXY] Sending request ${method} (id: ${requestId}) to ${targetServer}`);
    console.log(`[MCP-PROXY] Request payload:`, JSON.stringify(request, null, 2));

    // Prepare headers
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
    };

    // Add API key if provided
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
        console.log(`[MCP-PROXY] Adding Authorization header with API key`);
    }

    // Register response promise BEFORE sending request
    const responsePromise = new Promise<any>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            if (connection.responsePromises.has(requestId)) {
                connection.responsePromises.delete(requestId);
                reject(new Error(`SSE response timeout for ${method}`));
            }
        }, 30000);

        connection.responsePromises.set(requestId, {
            resolve: (value: any) => {
                clearTimeout(timeoutId);
                resolve(value);
            },
            reject: (error: any) => {
                clearTimeout(timeoutId);
                reject(error);
            }
        });
    });

    // Send POST request to target server
    const response = await fetch(connection.postUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(request)
    });

    console.log(`[MCP-PROXY] Response status: ${response.status}`);
    console.log(`[MCP-PROXY] Response headers:`, JSON.stringify(Object.fromEntries(response.headers.entries()), null, 2));

    if (!response.ok) {
        throw new Error(`Target server error: ${response.status}`);
    }

    // Handle different response types
    const contentType = response.headers.get('content-type') || '';
    console.log(`[MCP-PROXY] Content type: ${contentType}`);

    if (contentType.includes('application/json')) {
        const jsonResponse = await response.json();
        console.log(`[MCP-PROXY] JSON response:`, JSON.stringify(jsonResponse, null, 2));
        return jsonResponse;
    }

    if (contentType.includes('text/event-stream')) {
        // Parse SSE response
        const text = await response.text();
        console.log(`[MCP-PROXY] SSE response text:`, text);
        const parsedResponse = parseSseResponse(text);
        console.log(`[MCP-PROXY] Parsed SSE response:`, JSON.stringify(parsedResponse, null, 2));
        return parsedResponse;
    }

    // Handle 202 Accepted with empty content-type (Pizzaz pattern)
    if (response.status === 202 && !contentType) {
        console.log(`[MCP-PROXY] Waiting for SSE response for request ${requestId}`);
        return responsePromise;
    }

    throw new Error(`Unexpected content-type: ${contentType}`);
}

// Create or get cached connection with persistent SSE
async function getConnection(targetServer: string, apiKey?: string): Promise<CachedConnection> {
    console.log(`[MCP-PROXY] getConnection called for: ${targetServer}, apiKey: ${apiKey ? 'present' : 'missing'}`);
    // Check cache first
    const cached = connectionCache.get(targetServer);
    if (cached && cached.isHealthy) {
        cached.lastUsed = Date.now();
        console.log(`[MCP-PROXY] Using cached connection for: ${targetServer}, sessionId: ${cached.sessionId}`);
        return cached;
    }

    console.log(`[MCP-PROXY] Creating new connection to: ${targetServer}`);

    // Parse target server URL - add http:// if no protocol specified
    let targetUrl: URL;
    try {
        targetUrl = new URL(targetServer);
    } catch (e) {
        // If URL parsing fails, assume it's missing protocol and add http://
        console.log(`[MCP-PROXY] URL parsing failed, adding http:// protocol: ${targetServer}`);
        targetUrl = new URL(`http://${targetServer}`);
    }

    const baseUrl = `${targetUrl.protocol}//${targetUrl.host}`;
    const ssePath = targetUrl.pathname;
    const postPath = '/mcp/messages';

    console.log(`[MCP-PROXY] Parsed target server details:`, {
        targetServer,
        baseUrl,
        ssePath,
        postPath
    });

    // Prepare SSE headers
    const sseHeaders: Record<string, string> = {
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'ngrok-skip-browser-warning': '1'
    };

    // Add API key if provided
    if (apiKey) {
        sseHeaders['Authorization'] = `Bearer ${apiKey}`;
        console.log(`[MCP-PROXY] Adding Authorization header to SSE connection`);
    }

    // Create SSE connection to target server
    const sseUrl = `${baseUrl}${ssePath}`;
    console.log(`[MCP-PROXY] Creating SSE connection to: ${sseUrl}`);
    const sseResp = await fetch(sseUrl, {
        method: 'GET',
        headers: sseHeaders
    });

    console.log(`[MCP-PROXY] SSE response status: ${sseResp.status}`);
    console.log(`[MCP-PROXY] SSE response headers:`, JSON.stringify(Object.fromEntries(sseResp.headers.entries()), null, 2));
    console.log(`[MCP-PROXY] SSE connection attempt to: ${sseUrl}`);

    if (!sseResp.ok) {
        throw new Error(`Failed to connect to target server: ${sseResp.status}`);
    }

    // Extract session ID from SSE response
    let sessionId: string | undefined;
    const bodyStream = sseResp.body;
    if (!bodyStream) {
        throw new Error('No readable body from SSE response');
    }

    // Read initial SSE data to get session ID
    const reader = bodyStream.getReader();
    const decoder = new TextDecoder();
    let sessionFound = false;
    let bootstrapData = '';

    console.log(`[MCP-PROXY] Reading SSE data to extract session ID from: ${sseUrl}`);
    while (!sessionFound) {
        const { value, done } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        bootstrapData += chunk;
        console.log(`[MCP-PROXY] SSE chunk from ${sseUrl}:`, chunk);

        // Look for session ID in various formats
        const sessionMatch = chunk.match(/sessionId[=:]\s*([A-Za-z0-9._~\-]+)/i);
        if (sessionMatch?.[1]) {
            sessionId = sessionMatch[1];
            sessionFound = true;
            console.log(`[MCP-PROXY] Found session ID: ${sessionId}`);
        }
    }

    if (!sessionId) {
        console.log(`[MCP-PROXY] Session ID not found in chunks, trying bootstrap data...`);
        console.log(`[MCP-PROXY] Bootstrap data:`, bootstrapData);
        // Try to extract from bootstrap data
        const sessionMatch = bootstrapData.match(/sessionId[=:]\s*([A-Za-z0-9._~\-]+)/i);
        if (sessionMatch?.[1]) {
            sessionId = sessionMatch[1];
            console.log(`[MCP-PROXY] Found session ID in bootstrap data: ${sessionId}`);
        } else {
            console.log(`[MCP-PROXY] Failed to extract session ID from SSE response`);
            throw new Error('Failed to extract session ID from SSE response');
        }
    }

    // Create connection object
    const connection: CachedConnection = {
        sessionId,
        postUrl: `${baseUrl}${postPath}?sessionId=${sessionId}`,
        baseUrl,
        ssePath,
        lastUsed: Date.now(),
        isHealthy: true,
        responsePromises: new Map(),
        sseReader: reader
    };

    console.log(`[MCP-PROXY] Created connection object:`, {
        sessionId,
        postUrl: connection.postUrl,
        baseUrl: connection.baseUrl,
        ssePath: connection.ssePath
    });

    // Start SSE response listener
    console.log(`[MCP-PROXY] Starting SSE response listener for new connection`);
    startSseResponseListener(connection);

    // Cache the connection
    connectionCache.set(targetServer, connection);
    console.log(`[MCP-PROXY] Cached connection for: ${targetServer}, sessionId: ${sessionId}`);

    return connection;
}

// Start SSE response listener for a connection
function startSseResponseListener(connection: CachedConnection) {
    if (!connection.sseReader) return;

    let buffer = '';
    const readLoop = async () => {
        try {
            while (true) {
                const { value, done } = await connection.sseReader!.read();
                if (done) {
                    console.log(`[MCP-PROXY] SSE stream ended for connection`);
                    connection.isHealthy = false;
                    break;
                }

                const chunk = new TextDecoder().decode(value, { stream: true });
                buffer += chunk;

                // Process complete SSE events (ending with \n\n)
                let eventEnd;
                while ((eventEnd = buffer.indexOf('\n\n')) !== -1) {
                    const eventText = buffer.substring(0, eventEnd);
                    buffer = buffer.substring(eventEnd + 2);

                    console.log(`[MCP-PROXY] Processing complete SSE event (${eventText.length} chars)`);

                    // Parse SSE response
                    try {
                        const json = parseSseResponse(eventText);
                        console.log(`[MCP-PROXY] Parsed SSE response:`, json);

                        // Match response to pending request
                        if (json.id && connection.responsePromises.has(json.id.toString())) {
                            console.log(`[MCP-PROXY] Matched response for id: ${json.id}`);
                            const { resolve } = connection.responsePromises.get(json.id.toString())!;
                            connection.responsePromises.delete(json.id.toString());
                            resolve(json);
                        } else {
                            console.log(`[MCP-PROXY] No match for response id: ${json.id}`);
                        }
                    } catch (e) {
                        console.log(`[MCP-PROXY] Failed to parse SSE response:`, e);
                    }
                }
            }
        } catch (error) {
            console.error(`[MCP-PROXY] SSE listener error:`, error);
            console.error(`[MCP-PROXY] SSE listener error stack:`, error instanceof Error ? error.stack : 'No stack trace');
            connection.isHealthy = false;

            // Reject all pending requests
            console.log(`[MCP-PROXY] Rejecting ${connection.responsePromises.size} pending requests`);
            for (const { reject } of connection.responsePromises.values()) {
                reject(error);
            }
            connection.responsePromises.clear();
        }
    };

    // Start the listener
    console.log(`[MCP-PROXY] Starting SSE response listener for connection`);
    readLoop();
}

// Handle MCP requests
async function handleMcpRequest(req: IncomingMessage, res: ServerResponse) {
    try {
        // Verify API key
        if (!verifyApiKey(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
        }

        // Get target server
        const targetServer = getTargetServer(req);
        if (!targetServer) {
            console.log(`[MCP-PROXY] Missing X-Target-Server header`);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing X-Target-Server header' }));
            return;
        }

        // Read request body
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', async () => {
            try {
                console.log(`[MCP-PROXY] Request body: ${body}`);
                const request = JSON.parse(body);
                console.log(`[MCP-PROXY] Parsed request:`, JSON.stringify(request, null, 2));
                console.log(`[MCP-PROXY] Handling request: ${request.method} to ${targetServer}`);

                // Extract API key from X-Target-Api-Key header
                const targetApiKey = req.headers['x-target-api-key'] as string;
                console.log(`[MCP-PROXY] Extracted target API key: ${targetApiKey ? 'present' : 'missing'}`);

                // Forward request to target server via persistent SSE connection
                const response = await forwardToTarget(targetServer, request.method, request.params, targetApiKey);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(response));

            } catch (error) {
                console.error(`[MCP-PROXY] Error handling request:`, error);
                console.error(`[MCP-PROXY] Error stack:`, error instanceof Error ? error.stack : 'No stack trace');
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    id: null,
                    error: {
                        code: -32603,
                        message: 'Internal server error',
                        data: error instanceof Error ? error.message : String(error)
                    }
                }));
            }
        });

    } catch (error) {
        console.error(`[MCP-PROXY] Outer error:`, error);
        console.error(`[MCP-PROXY] Outer error stack:`, error instanceof Error ? error.stack : 'No stack trace');
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
    }
}

// Health check endpoint
function handleHealthCheck(req: IncomingMessage, res: ServerResponse) {
    console.log(`[MCP-PROXY] Health check requested`);
    const healthData = {
        status: 'healthy',
        connections: connectionCache.size,
        timestamp: new Date().toISOString()
    };
    console.log(`[MCP-PROXY] Health check response:`, healthData);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(healthData));
}

// Create HTTP server
const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Target-Server');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (!req.url) {
        console.log(`[MCP-PROXY] Missing URL`);
        res.writeHead(400).end('Missing URL');
        return;
    }

    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

    console.log(`[MCP-PROXY] ${req.method} ${url.pathname}`);
    console.log(`[MCP-PROXY] Request URL: ${req.url}`);
    console.log(`[MCP-PROXY] Headers:`, JSON.stringify(req.headers, null, 2));

    if (req.method === 'GET' && url.pathname === '/health') {
        console.log('[MCP-PROXY] Health check requested');
        handleHealthCheck(req, res);
        return;
    }

    if (req.method === 'POST' && url.pathname === '/mcp') {
        console.log('[MCP-PROXY] MCP request received');
        await handleMcpRequest(req, res);
        return;
    }

    res.writeHead(404).end('Not Found');
});

// Start server
const port = process.env.PORT || 10000;
httpServer.listen(port, () => {
    console.log(`[MCP-PROXY] Server listening on port ${port}`);
    console.log(`[MCP-PROXY] Health check: http://localhost:${port}/health`);
    console.log(`[MCP-PROXY] MCP endpoint: http://localhost:${port}/mcp`);
    console.log(`[MCP-PROXY] API Key: ${API_KEY}`);
    console.log(`[MCP-PROXY] Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`[MCP-PROXY] Cache TTL: ${CACHE_TTL}ms`);
    console.log(`[MCP-PROXY] Cleanup interval: ${CLEANUP_INTERVAL}ms`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('[MCP-PROXY] SIGTERM received, shutting down...');
    console.log(`[MCP-PROXY] Active connections: ${connectionCache.size}`);
    httpServer.close(() => {
        console.log('[MCP-PROXY] Server closed');
        process.exit(0);
    });
});

export { httpServer };