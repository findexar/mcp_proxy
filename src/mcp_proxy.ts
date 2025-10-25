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
    for (const [url, connection] of connectionCache.entries()) {
        if (now - connection.lastUsed > CACHE_TTL) {
            console.log(`[MCP-PROXY] Cleaning up expired connection: ${url}`);
            connectionCache.delete(url);
        }
    }
}, CLEANUP_INTERVAL);

// Extract target server from headers
function getTargetServer(req: IncomingMessage): string | null {
    const targetServer = req.headers['x-target-server'] as string;
    if (!targetServer) {
        console.log('[MCP-PROXY] Missing X-Target-Server header');
        return null;
    }
    return targetServer;
}

// Verify API key
function verifyApiKey(req: IncomingMessage): boolean {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
        console.log('[MCP-PROXY] Missing or invalid Authorization header');
        return false;
    }

    const token = auth.substring(7);
    if (token !== API_KEY) {
        console.log('[MCP-PROXY] Invalid API key');
        return false;
    }

    return true;
}

// Parse SSE response to extract JSON
function parseSseResponse(sseText: string): any {
    const dataLines = sseText
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim())
        .filter(s => s.length > 0);

    if (dataLines.length === 0) {
        throw new Error('No data in SSE response');
    }

    // Use the last data line as the final JSON-RPC response
    const lastLine = dataLines[dataLines.length - 1];
    if (!lastLine) {
        throw new Error('No data in SSE response');
    }

    try {
        return JSON.parse(lastLine);
    } catch (e) {
        // Try joining all data lines in case JSON was split across frames
        try {
            const joined = dataLines.join('');
            return JSON.parse(joined);
        } catch (e2) {
            throw new Error(`Failed to parse SSE JSON: ${e2}`);
        }
    }
}

// Forward request to target server via persistent SSE connection
async function forwardToTarget(targetServer: string, method: string, params: any): Promise<any> {
    const connection = await getConnection(targetServer);
    const requestId = Math.floor(Math.random() * 1000000).toString();

    // Create JSON-RPC request
    const request = {
        jsonrpc: '2.0',
        method: method,
        params: params,
        id: requestId
    };

    console.log(`[MCP-PROXY] Sending request ${method} (id: ${requestId}) to ${targetServer}`);

    // Send POST request to target server
    const response = await fetch(connection.postUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream'
        },
        body: JSON.stringify(request)
    });

    if (!response.ok) {
        throw new Error(`Target server error: ${response.status}`);
    }

    // Handle different response types
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
        return await response.json();
    }

    if (contentType.includes('text/event-stream')) {
        // Parse SSE response
        const text = await response.text();
        return parseSseResponse(text);
    }

    // Handle 202 Accepted with empty content-type (Pizzaz pattern)
    if (response.status === 202 && !contentType) {
        console.log(`[MCP-PROXY] Waiting for SSE response for request ${requestId}`);

        // Wait for response via SSE stream
        return new Promise((resolve, reject) => {
            connection.responsePromises.set(requestId, { resolve, reject });

            // Set timeout
            setTimeout(() => {
                if (connection.responsePromises.has(requestId)) {
                    connection.responsePromises.delete(requestId);
                    reject(new Error(`SSE response timeout for ${method}`));
                }
            }, 30000); // 30 second timeout
        });
    }

    throw new Error(`Unexpected content-type: ${contentType}`);
}

// Create or get cached connection with persistent SSE
async function getConnection(targetServer: string): Promise<CachedConnection> {
    // Check cache first
    const cached = connectionCache.get(targetServer);
    if (cached && cached.isHealthy) {
        cached.lastUsed = Date.now();
        console.log(`[MCP-PROXY] Using cached connection for: ${targetServer}`);
        return cached;
    }

    console.log(`[MCP-PROXY] Creating new connection to: ${targetServer}`);

    // Parse target server URL
    const targetUrl = new URL(targetServer);
    const baseUrl = `${targetUrl.protocol}//${targetUrl.host}`;
    const ssePath = targetUrl.pathname;
    const postPath = '/mcp/messages';

    // Create SSE connection to target server
    const sseUrl = `${baseUrl}${ssePath}`;
    const sseResp = await fetch(sseUrl, {
        method: 'GET',
        headers: {
            'Accept': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'ngrok-skip-browser-warning': '1'
        }
    });

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

    while (!sessionFound) {
        const { value, done } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        bootstrapData += chunk;

        // Look for session ID in various formats
        const sessionMatch = chunk.match(/sessionId[=:]\s*([A-Za-z0-9._~\-]+)/i);
        if (sessionMatch?.[1]) {
            sessionId = sessionMatch[1];
            sessionFound = true;
        }
    }

    if (!sessionId) {
        // Try to extract from bootstrap data
        const sessionMatch = bootstrapData.match(/sessionId[=:]\s*([A-Za-z0-9._~\-]+)/i);
        if (sessionMatch?.[1]) {
            sessionId = sessionMatch[1];
        } else {
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

    // Start SSE response listener
    startSseResponseListener(connection);

    // Cache the connection
    connectionCache.set(targetServer, connection);
    console.log(`[MCP-PROXY] Cached connection for: ${targetServer}, sessionId: ${sessionId}`);

    return connection;
}

// Start SSE response listener for a connection
function startSseResponseListener(connection: CachedConnection) {
    if (!connection.sseReader) return;

    const readLoop = async () => {
        try {
            while (true) {
                const { value, done } = await connection.sseReader!.read();
                if (done) {
                    console.log(`[MCP-PROXY] SSE stream ended for connection`);
                    connection.isHealthy = false;
                    break;
                }

                const text = new TextDecoder().decode(value);
                console.log(`[MCP-PROXY] SSE data received: ${text.slice(0, 200)}...`);

                // Parse SSE response
                try {
                    const json = parseSseResponse(text);
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
        } catch (error) {
            console.error(`[MCP-PROXY] SSE listener error:`, error);
            connection.isHealthy = false;

            // Reject all pending requests
            for (const { reject } of connection.responsePromises.values()) {
                reject(error);
            }
            connection.responsePromises.clear();
        }
    };

    // Start the listener
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
                const request = JSON.parse(body);
                console.log(`[MCP-PROXY] Handling request: ${request.method} to ${targetServer}`);

                // Forward request to target server via persistent SSE connection
                const response = await forwardToTarget(targetServer, request.method, request.params);

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(response));

            } catch (error) {
                console.error(`[MCP-PROXY] Error handling request:`, error);
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
        console.error(`[MCP-PROXY] Error:`, error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
    }
}

// Health check endpoint
function handleHealthCheck(req: IncomingMessage, res: ServerResponse) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        status: 'healthy',
        connections: connectionCache.size,
        timestamp: new Date().toISOString()
    }));
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
        res.writeHead(400).end('Missing URL');
        return;
    }

    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

    console.log(`[MCP-PROXY] ${req.method} ${url.pathname}`);

    if (req.method === 'GET' && url.pathname === '/health') {
        handleHealthCheck(req, res);
        return;
    }

    if (req.method === 'POST' && url.pathname === '/mcp') {
        await handleMcpRequest(req, res);
        return;
    }

    res.writeHead(404).end('Not Found');
});

// Start server
const port = process.env.PORT || 8008;
httpServer.listen(port, () => {
    console.log(`[MCP-PROXY] Server listening on port ${port}`);
    console.log(`[MCP-PROXY] Health check: http://localhost:${port}/health`);
    console.log(`[MCP-PROXY] MCP endpoint: http://localhost:${port}/mcp`);
    console.log(`[MCP-PROXY] API Key: ${API_KEY}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('[MCP-PROXY] Shutting down...');
    httpServer.close(() => {
        console.log('[MCP-PROXY] Server closed');
        process.exit(0);
    });
});

export { httpServer };