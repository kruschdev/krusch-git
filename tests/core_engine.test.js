import test from 'node:test';
import assert from 'node:assert';
import { extractSymbolsAndImports } from '../lib/ast-chunker.js';
import { resolveBlobContent } from '../server/git-engine.js';

test('Core Math: Temporal Exponential Decay calculation', () => {
    // Decay formula: score = cosine * exp(-0.01 * age_days)
    const decayRate = 0.01;
    const calculateDecay = (score, ageDays) => score * Math.exp(-decayRate * ageDays);

    const baseScore = 0.95;
    
    // Day 0: no decay
    const day0 = calculateDecay(baseScore, 0);
    assert.strictEqual(day0, 0.95);

    // Day 30: ~26% decay (factor ~0.740818)
    const day30 = calculateDecay(baseScore, 30);
    const expected30 = 0.95 * Math.exp(-0.30);
    assert.ok(Math.abs(day30 - expected30) < 1e-6);
    assert.ok(day30 < baseScore);
    assert.ok(day30 > 0.70);

    // Day 100: ~63% decay (factor ~0.367879)
    const day100 = calculateDecay(baseScore, 100);
    const expected100 = 0.95 * Math.exp(-1.0);
    assert.ok(Math.abs(day100 - expected100) < 1e-6);
    assert.ok(day100 < day30);

    // Newer identical match always beats older match
    const freshIdentical = calculateDecay(0.80, 2);
    const staleIdentical = calculateDecay(0.80, 180);
    assert.ok(freshIdentical > staleIdentical);
});

test('Core Math: Reciprocal Rank Fusion (RRF) calculation', () => {
    // RRF(d) = 1 / (k + rank_dense) + 1 / (k + rank_bm25) where k = 60
    const k = 60;
    const rrf = (denseRank, bm25Rank) => {
        let score = 0;
        if (denseRank != null) score += 1 / (k + denseRank);
        if (bm25Rank != null) score += 1 / (k + bm25Rank);
        return score;
    };

    // Both rank 1 (top match in both dense and sparse)
    const topMatch = rrf(1, 1);
    assert.strictEqual(topMatch, 2 / 61);

    // Dense rank 1 only
    const denseOnly = rrf(1, null);
    assert.strictEqual(denseOnly, 1 / 61);

    // Fused match beats single-modality match
    assert.ok(topMatch > denseOnly);

    // Higher ranks produce higher scores
    assert.ok(rrf(1, 5) > rrf(5, 5));
});

test('Pointer Resolution: safely handles null, direct, and missing pointer blobs', async () => {
    // 1. Null blob returns null
    const nullResult = await resolveBlobContent(null);
    assert.strictEqual(nullResult, null);

    // 2. Direct storage returns content directly
    const directBlob = {
        id: 101,
        storage_mode: 'direct',
        content: Buffer.from('console.log("hello world");')
    };
    const directResult = await resolveBlobContent(directBlob);
    assert.strictEqual(directResult.toString(), 'console.log("hello world");');

    // 3. Pointer mode with missing file does not throw uncaught error, returns null safely
    const missingPointer = {
        id: 999,
        storage_mode: 'pointer',
        project: 'non-existent-project-xyz',
        file_path: 'does_not_exist.js'
    };
    const missingResult = await resolveBlobContent(missingPointer);
    assert.strictEqual(missingResult, null);
});

test('AST Chunker: robust extraction of symbols and import edges on JS fixture', () => {
    const jsFixture = `
import { Router } from 'express';
import { pool } from '../db/pool.js';

export class SymbolSearchEngine {
    constructor(options = {}) {
        this.options = options;
    }

    async findCallers(symbolName) {
        return pool.query('SELECT * FROM code_symbols WHERE name = $1', [symbolName]);
    }
}

export function createRouter() {
    const router = Router();
    router.get('/health', (req, res) => res.json({ status: 'ok' }));
    return router;
}
`;

    const { symbols, imports } = extractSymbolsAndImports(jsFixture, 'search-engine.js');

    // Should extract imports
    assert.ok(imports.length >= 2);
    const importModules = imports.map(i => i.targetPath);
    assert.ok(importModules.includes('express'));
    assert.ok(importModules.includes('../db/pool.js'));

    // Should extract class and methods
    const classSym = symbols.find(s => s.type === 'class' && s.name === 'SymbolSearchEngine');
    assert.ok(classSym, 'SymbolSearchEngine class must be extracted');
    assert.strictEqual(classSym.startLine, 5);

    const methodSym = symbols.find(s => s.type === 'method' && s.name === 'SymbolSearchEngine.findCallers');
    assert.ok(methodSym, 'findCallers method must be extracted');

    // Should extract exported function
    const funcSym = symbols.find(s => s.type === 'function' && s.name === 'createRouter');
    assert.ok(funcSym, 'createRouter function must be extracted');
});

test('AST Chunker: TypeScript interfaces, type aliases, and enums', () => {
    const tsFixture = `
import type { Request, Response } from 'express';

export interface UserSession {
    userId: string;
    token: string;
    roles: string[];
}

export type AuthStatus = 'authenticated' | 'anonymous' | 'expired';

export enum RoleLevel {
    GUEST = 0,
    USER = 1,
    ADMIN = 2,
}
`;

    const { symbols, imports } = extractSymbolsAndImports(tsFixture, 'types/auth.ts');

    assert.ok(imports.length >= 1);
    assert.strictEqual(imports[0].targetPath, 'express');
    assert.ok(imports[0].symbols.includes('Request'));
    assert.ok(imports[0].symbols.includes('Response'));

    // Interface check
    const iface = symbols.find(s => s.name === 'UserSession');
    assert.ok(iface, 'Should extract UserSession interface');
    assert.strictEqual(iface.symbol_type, 'type');
    assert.ok(iface.startLine > 0);
    assert.ok(iface.endLine >= iface.startLine);

    // Type alias check
    const typeAlias = symbols.find(s => s.name === 'AuthStatus');
    assert.ok(typeAlias, 'Should extract AuthStatus type alias');
    assert.strictEqual(typeAlias.symbol_type, 'type');

    // Enum check
    const enumSym = symbols.find(s => s.name === 'RoleLevel');
    assert.ok(enumSym, 'Should extract RoleLevel enum');
    assert.strictEqual(enumSym.symbol_type, 'type');
});

test('AST Chunker: Python multiline imports, routes (FastAPI & Flask), and multiline defs', () => {
    const pyFixture = `
from typing import (
    List,
    Optional,
    Dict as DictType
)
import os, sys

@app.get("/api/v1/items/{item_id}")
async def get_item(
    item_id: int,
    include_metadata: bool = False
) -> DictType:
    return {"id": item_id}

@bp.route("/auth/login", methods=["POST", "GET"])
def login():
    return "ok"
`;

    const { symbols, imports } = extractSymbolsAndImports(pyFixture, 'api/routes.py');

    // Imports check
    const typingImport = imports.find(i => i.targetPath === 'typing');
    assert.ok(typingImport, 'Should extract multiline typing import');
    assert.ok(typingImport.symbols.includes('List'));
    assert.ok(typingImport.symbols.includes('Optional'));
    assert.ok(typingImport.symbols.includes('Dict'));

    // FastAPI route check
    const fastapiRoute = symbols.find(s => s.type === 'route' && s.name === 'GET /api/v1/items/{item_id}');
    assert.ok(fastapiRoute, 'Should extract FastAPI GET route symbol');
    assert.strictEqual(fastapiRoute.symbol_type, 'route');
    assert.ok(fastapiRoute.signature.includes('@app.get'));

    // Flask route check (multiple methods in decorator)
    const flaskPost = symbols.find(s => s.type === 'route' && s.name === 'POST /auth/login');
    const flaskGet = symbols.find(s => s.type === 'route' && s.name === 'GET /auth/login');
    assert.ok(flaskPost, 'Should extract Flask POST route symbol');
    assert.ok(flaskGet, 'Should extract Flask GET route symbol');

    // Multiline function def check
    const fnSym = symbols.find(s => s.type === 'function' && s.name === 'get_item');
    assert.ok(fnSym, 'Should extract multiline get_item function');
    assert.ok(fnSym.endLine >= fnSym.startLine + 4);
});

test('AST Chunker: Go functions, receiver methods, structs, and imports with exact brace blocks', () => {
    const goFixture = `
package server

import (
    "fmt"
    "net/http"
    gin "github.com/gin-gonic/gin"
)

type ServerConfig struct {
    Port int
    Host string
}

func (s *ServerConfig) Start() error {
    fmt.Printf("Starting on %d", s.Port)
    return nil
}

func NewConfig(port int) *ServerConfig {
    return &ServerConfig{
        Port: port,
        Host: "127.0.0.1",
    }
}
`;

    const { symbols, imports } = extractSymbolsAndImports(goFixture, 'pkg/server.go');

    // Imports check
    assert.ok(imports.some(i => i.targetPath === 'fmt'));
    assert.ok(imports.some(i => i.targetPath === 'net/http'));
    assert.ok(imports.some(i => i.targetPath === 'github.com/gin-gonic/gin'));

    // Struct check
    const structSym = symbols.find(s => s.name === 'ServerConfig');
    assert.ok(structSym, 'Should extract ServerConfig struct');
    assert.strictEqual(structSym.symbol_type, 'type');
    assert.strictEqual(structSym.startLine, 10);
    assert.strictEqual(structSym.endLine, 13);

    // Method with receiver check
    const methodSym = symbols.find(s => s.name === 'ServerConfig.Start');
    assert.ok(methodSym, 'Should extract receiver method ServerConfig.Start');
    assert.strictEqual(methodSym.symbol_type, 'method');
    assert.strictEqual(methodSym.startLine, 15);
    assert.strictEqual(methodSym.endLine, 18);

    // Function check
    const funcSym = symbols.find(s => s.name === 'NewConfig');
    assert.ok(funcSym, 'Should extract NewConfig function');
    assert.strictEqual(funcSym.symbol_type, 'function');
    assert.strictEqual(funcSym.startLine, 20);
    assert.strictEqual(funcSym.endLine, 25);
});

test('AST Chunker: Rust functions, structs, enums, traits, and use imports with exact brace blocks', () => {
    const rustFixture = `
use std::sync::Arc;
use crate::models::{User, Account};

pub struct ClusterConfig {
    pub node_id: u64,
}

pub trait WorkerPool {
    fn process_task(&self, task_id: &str) -> bool;
}

pub async fn start_worker(cfg: ClusterConfig) -> Arc<ClusterConfig> {
    println!("Node: {}", cfg.node_id);
    Arc::new(cfg)
}
`;

    const { symbols, imports } = extractSymbolsAndImports(rustFixture, 'src/worker.rs');

    // Imports check
    assert.ok(imports.some(i => i.targetPath === 'std::sync::Arc'));
    const modelsImport = imports.find(i => i.targetPath === 'crate::models');
    assert.ok(modelsImport);
    assert.ok(modelsImport.symbols.includes('User'));
    assert.ok(modelsImport.symbols.includes('Account'));

    // Struct check
    const structSym = symbols.find(s => s.name === 'ClusterConfig');
    assert.ok(structSym, 'Should extract ClusterConfig struct');
    assert.strictEqual(structSym.symbol_type, 'type');
    assert.strictEqual(structSym.startLine, 5);
    assert.strictEqual(structSym.endLine, 7);

    // Trait check
    const traitSym = symbols.find(s => s.name === 'WorkerPool');
    assert.ok(traitSym, 'Should extract WorkerPool trait');
    assert.strictEqual(traitSym.symbol_type, 'type');
    assert.strictEqual(traitSym.startLine, 9);
    assert.strictEqual(traitSym.endLine, 11);

    // Function check
    const funcSym = symbols.find(s => s.name === 'start_worker');
    assert.ok(funcSym, 'Should extract start_worker async function');
    assert.strictEqual(funcSym.symbol_type, 'function');
    assert.strictEqual(funcSym.startLine, 13);
    assert.strictEqual(funcSym.endLine, 16);
});

test('AST Chunker: Shell functions with exact brace boundaries', () => {
    const shFixture = `
#!/usr/bin/env bash

# Deploy cluster service
deploy_cluster() {
    echo "Starting cluster deployment..."
    systemctl restart dbos
    return 0
}

function stop_cluster {
    echo "Stopping..."
    exit 0
}
`;

    const { symbols } = extractSymbolsAndImports(shFixture, 'scripts/deploy.sh');

    const fn1 = symbols.find(s => s.name === 'deploy_cluster');
    assert.ok(fn1, 'Should extract deploy_cluster shell function');
    assert.strictEqual(fn1.startLine, 5);
    assert.strictEqual(fn1.endLine, 9);

    const fn2 = symbols.find(s => s.name === 'stop_cluster');
    assert.ok(fn2, 'Should extract stop_cluster shell function');
    assert.strictEqual(fn2.startLine, 11);
    assert.strictEqual(fn2.endLine, 14);
});

