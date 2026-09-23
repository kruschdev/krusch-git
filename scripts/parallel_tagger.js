import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, 'generate_tags.js');

const nodes = [
    {
        host: 'http://10.0.0.19:11434', // kruschgame
        repos: ['langchainjs', 'ai', 'typescript-sdk', 'mcp-servers', 'mastra', 'langgraphjs']
    },
    {
        host: 'http://127.0.0.1:11434', // kruschdev
        repos: ['openai-node', 'generative-ai-js', 'LlamaIndexTS', 'voltagent', 'langchain', 'agent-framework']
    },
    {
        host: 'http://10.0.0.85:11434', // kruschserv
        repos: ['ai-agents-for-beginners', 'goose-repo', 'generative-ai', 'openai-cookbook', 'beeai-framework', 'GenAI_Agents']
    }
];

async function runForNode(nodeConfig) {
    for (const repo of nodeConfig.repos) {
        console.log(`Starting ${repo} on ${nodeConfig.host}`);
        await new Promise((resolve) => {
            const child = spawn('node', [scriptPath, `--project=${repo}`], {
                env: {
                    ...process.env,
                    TAG_OLLAMA_HOST: nodeConfig.host,
                    TAG_CONCURRENCY: '2',
                    TAG_MODEL: 'qwen2.5-coder:1.5b'
                },
                stdio: ['ignore', 'append', 'append']
            });
            child.on('close', resolve);
        });
        console.log(`Finished ${repo} on ${nodeConfig.host}`);
    }
}

async function main() {
    console.log('Starting parallel taggers...');
    await Promise.all(nodes.map(runForNode));
    console.log('All nodes finished!');
}

main().catch(console.error);
