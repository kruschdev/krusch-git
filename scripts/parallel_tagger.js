import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, 'generate_tags.js');

const ALL_EXTERNAL_REPOS = [
    'langchainjs', 'ai', 'typescript-sdk', 'mcp-servers', 'mastra', 'langgraphjs',
    'openai-node', 'generative-ai-js', 'LlamaIndexTS', 'voltagent', 'langchain', 'agent-framework',
    'ai-agents-for-beginners', 'goose-repo', 'generative-ai', 'openai-cookbook', 'beeai-framework', 'GenAI_Agents'
];

// INV-GIT-05: Multi-GPU Fleet Topology specialization:
// Default to local Ollama (127.0.0.1:11434) or TAG_OLLAMA_HOST for qwen2.5-coder:7b (TAG_MODEL)
// to prevent VRAM thrashing on secondary compute nodes,
// unless additional tag hosts are explicitly overridden via environment variables.
function buildNodes() {
    const primaryHost = process.env.TAG_OLLAMA_HOST || process.env.KRUSCH_OLLAMA_HOST || 'http://127.0.0.1:11434';
    const extraHosts = [
        process.env.KRUSCHDEV_TAG_HOST || process.env.KRUSCHDEV_OLLAMA_HOST,
        process.env.KRUSCHSERV_TAG_HOST || process.env.KRUSCHSERV_OLLAMA_HOST
    ].filter(Boolean);

    const activeHosts = [primaryHost, ...extraHosts];
    return activeHosts.map((host, idx) => ({
        host,
        repos: ALL_EXTERNAL_REPOS.filter((_, rIdx) => rIdx % activeHosts.length === idx)
    }));
}

export const NODES = buildNodes();
const nodes = NODES;

export async function runForNode(nodeConfig) {
    for (const repo of nodeConfig.repos) {
        console.log(`Starting ${repo} on ${nodeConfig.host}`);
        await new Promise((resolve, reject) => {
            const child = spawn('node', [scriptPath, `--project=${repo}`], {
                env: {
                    ...process.env,
                    TAG_OLLAMA_HOST: nodeConfig.host,
                    TAG_CONCURRENCY: process.env.TAG_CONCURRENCY || '2',
                    TAG_MODEL: process.env.TAG_MODEL || 'qwen2.5-coder:7b'
                },
                stdio: ['ignore', 'inherit', 'inherit']
            });
            child.on('error', reject);
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

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
    main().catch(console.error);
}

