#!/usr/bin/env node

// Simple test script to verify MCP proxy works with Pizzaz server
const fetch = require('node-fetch');

const PROXY_URL = 'http://localhost:8008';
const PIZZAZ_URL = 'http://localhost:8000/mcp';
const API_KEY = 'default-key';

async function testProxy() {
    console.log('🧪 Testing MCP Proxy with Pizzaz server...\n');

    try {
        // Test 1: Health check
        console.log('1. Testing health check...');
        const healthResponse = await fetch(`${PROXY_URL}/health`);
        const health = await healthResponse.json();
        console.log('✅ Health check:', health);

        // Test 2: Initialize
        console.log('\n2. Testing initialize...');
        const initResponse = await fetch(`${PROXY_URL}/mcp`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`,
                'X-Target-Server': PIZZAZ_URL
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'initialize',
                params: {
                    protocolVersion: '2024-11-05',
                    clientInfo: { name: 'Test Client', version: '1.0.0' },
                    capabilities: {}
                },
                id: 1
            })
        });

        const initResult = await initResponse.json();
        console.log('✅ Initialize result:', JSON.stringify(initResult, null, 2));

        // Test 3: List tools
        console.log('\n3. Testing tools/list...');
        const toolsResponse = await fetch(`${PROXY_URL}/mcp`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`,
                'X-Target-Server': PIZZAZ_URL
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'tools/list',
                params: {},
                id: 2
            })
        });

        const toolsResult = await toolsResponse.json();
        console.log('✅ Tools result:', JSON.stringify(toolsResult, null, 2));

        // Test 4: List resources
        console.log('\n4. Testing resources/list...');
        const resourcesResponse = await fetch(`${PROXY_URL}/mcp`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`,
                'X-Target-Server': PIZZAZ_URL
            },
            body: JSON.stringify({
                jsonrpc: '2.0',
                method: 'resources/list',
                params: {},
                id: 3
            })
        });

        const resourcesResult = await resourcesResponse.json();
        console.log('✅ Resources result:', JSON.stringify(resourcesResult, null, 2));

        console.log('\n🎉 All tests passed! MCP Proxy is working correctly.');

    } catch (error) {
        console.error('❌ Test failed:', error.message);
        process.exit(1);
    }
}

// Check if required services are running
async function checkServices() {
    try {
        // Check if Pizzaz server is running
        const pizzazResponse = await fetch('http://localhost:8000/mcp', {
            method: 'GET',
            headers: { 'Accept': 'text/event-stream' }
        });
        
        if (!pizzazResponse.ok) {
            throw new Error('Pizzaz server not running on localhost:8000');
        }
        
        console.log('✅ Pizzaz server is running');
    } catch (error) {
        console.error('❌ Pizzaz server not available:', error.message);
        console.log('Please start the Pizzaz server first:');
        console.log('  cd openai-apps-sdk-examples/pizzaz_server_node');
        console.log('  npm start');
        process.exit(1);
    }
}

async function main() {
    await checkServices();
    await testProxy();
}

main().catch(console.error);
