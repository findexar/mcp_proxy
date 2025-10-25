# MCP Proxy Service

A standalone proxy service that bridges modern HTTP streaming MCP interfaces with legacy SSE long-running connections.

## Problem Solved

- **5-second delay** on every MCP tool call due to SSE connection initialization
- **Serverless limitations** - Vercel functions cannot maintain persistent connections
- **Legacy SSE implementation** - Pizzaz server and similar use long-running SSE connections

## Solution

The MCP Proxy Service maintains persistent SSE connections to legacy servers while exposing a modern HTTP interface that `fetchMcpMetaData` can call transparently.

## Architecture

```
fetchMcpMetaData → HTTP POST → MCP Proxy → Persistent SSE → Legacy Server (Pizzaz)
```

## Features

- **Persistent SSE Connections**: Maintains long-running SSE connections to legacy servers
- **Connection Pooling**: Reuses connections across multiple requests
- **Health Monitoring**: Detects and reconnects failed SSE connections
- **Transparent Interface**: Looks like a regular HTTP MCP server to clients
- **Authentication**: Bearer token authentication for security

## Usage

### Environment Variables

```bash
MCP_PROXY_API_KEY=your-secure-api-key
PORT=3000
```

### Starting the Service

```bash
npm install
npm start
```

### Health Check

```bash
curl http://localhost:8008/health
```

### MCP Requests

```bash
curl -X POST http://localhost:8008/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -H "X-Target-Server: http://localhost:8000/mcp" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/list",
    "params": {},
    "id": 1
  }'
```

## Integration with Findexar

The proxy service integrates transparently with Findexar's `fetchMcpMetaData` function:

1. **Environment Variables**: Set `MCP_PROXY_URL` and `MCP_PROXY_API_KEY` in Findexar
2. **Automatic Detection**: `fetchMcpMetaData` automatically uses the proxy for legacy SSE servers
3. **No Code Changes**: Existing MCP discovery code works unchanged

## Testing

1. Start the Pizzaz server:

   ```bash
   cd openai-apps-sdk-examples/pizzaz_server_node
   npm start
   ```

2. Start the MCP proxy:

   ```bash
   cd mcp-proxy
   npm start
   ```

3. Run the test script:
   ```bash
   node test-proxy.js
   ```

## Deployment

### Render (Recommended)

1. Create a new Web Service on Render
2. Connect your GitHub repository
3. Set build command: `npm install`
4. Set start command: `npm start`
5. Add environment variables:
   - `MCP_PROXY_API_KEY`: Your secure API key
   - `PORT`: 3000 (auto-set by Render)

### Environment Variables for Findexar

Add these to your Findexar environment:

```bash
MCP_PROXY_URL=https://your-proxy-service.onrender.com
MCP_PROXY_API_KEY=your-secure-api-key
```

## Cost

- **Render Starter**: $7/month for always-on service
- **Performance**: Eliminates 5-second delays on every tool call
- **ROI**: Significant improvement in user experience

## API Reference

### POST /mcp

Handles MCP JSON-RPC requests.

**Headers:**

- `Authorization: Bearer <api-key>`
- `X-Target-Server: <legacy-server-url>`
- `Content-Type: application/json`

**Body:** Standard MCP JSON-RPC request

**Response:** Standard MCP JSON-RPC response

### GET /health

Health check endpoint.

**Response:**

```json
{
  "status": "healthy",
  "connections": 2,
  "timestamp": "2025-01-27T10:00:00.000Z"
}
```

## Development

```bash
# Install dependencies
npm install

# Start in development mode
npm run dev

# Build for production
npm run build
```

## Troubleshooting

### Connection Issues

- Check if the target server is running
- Verify the `X-Target-Server` header is correct
- Check proxy service logs for SSE connection errors

### Performance Issues

- Monitor connection cache size in health endpoint
- Check for connection timeouts
- Verify SSE stream is staying alive

### Authentication Issues

- Verify `MCP_PROXY_API_KEY` is set correctly
- Check Authorization header format
- Ensure API key matches between client and proxy
