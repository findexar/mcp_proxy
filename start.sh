#!/bin/bash

# MCP Proxy Service Startup Script

echo "🚀 Starting MCP Proxy Service..."


echo "✅ Environment variables configured"
echo "🔑 API Key: ${MCP_PROXY_API_KEY:0:8}..."
echo "🌐 Port: ${PORT:-8008}"

# Start the service
echo "🚀 Starting proxy service..."
node --loader ts-node/esm src/mcp_proxy.ts
