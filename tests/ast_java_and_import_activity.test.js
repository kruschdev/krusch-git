import test from 'node:test';
import assert from 'node:assert/strict';
import {
    extractSymbolsAndImports,
    analyzeImportSymbolActivity
} from '../lib/ast-chunker.js';

test('AST Chunker v1.2.3: extracts Java classes, interfaces, methods, and static/standard imports', () => {
    const javaSource = [
        'package com.example.auth;',
        '',
        'import java.util.List;',
        'import static com.example.crypto.HmacSigner.verifyDigest;',
        '',
        'public interface TokenVerifier {',
        '    boolean isValid(String rawToken);',
        '}',
        '',
        'public final class JwtService implements TokenVerifier {',
        '    private final String issuer;',
        '',
        '    public JwtService(String issuer) {',
        '        this.issuer = issuer;',
        '    }',
        '',
        '    @Override',
        '    public boolean isValid(String rawToken) {',
        '        if (rawToken == null || rawToken.isEmpty()) {',
        '            return false;',
        '        }',
        '        return verifyDigest(rawToken, issuer);',
        '    }',
        '}'
    ].join('\n');

    const parsed = extractSymbolsAndImports(javaSource, 'src/main/java/com/example/auth/JwtService.java');
    const importModules = parsed.imports.map((imp) => imp.module);
    assert.deepEqual(importModules, [
        'java.util.List',
        'com.example.crypto.HmacSigner.verifyDigest'
    ]);
    assert.deepEqual(parsed.imports[1].symbols, ['verifyDigest', 'HmacSigner']);

    const symbolNames = parsed.symbols.map((s) => `${s.type}:${s.name}`);
    assert.ok(symbolNames.includes('type:TokenVerifier'));
    assert.ok(symbolNames.includes('method:TokenVerifier.isValid'));
    assert.ok(symbolNames.includes('class:JwtService'));
    assert.ok(symbolNames.includes('method:JwtService.JwtService'));
    assert.ok(symbolNames.includes('method:JwtService.isValid'));
});

test('AST Chunker v1.2.3: analyzeImportSymbolActivity separates immediate_cursor, unused_staged, and earlier_only imports', () => {
    const importBlock = [
        'from telemetry.logger import AuditLogger as AL',
        'from billing.ledger import InvoiceBuilder',
        'from security.signer import PayloadSigner as PS'
    ].join('\n');

    const codePrefix = [
        '"""',
        'Module docstring mentioning InvoiceBuilder and PayloadSigner should be ignored.',
        '"""',
        'def init_audit():',
        '    audit = AL("billing")',
        '    audit.record_boot()',
        '    return audit',
        '',
        'def finalize_settlement(order_id: str, total_cents: int):',
        '    # Comment mentioning AL and InvoiceBuilder should also be ignored',
        '    signer = PS(secret_key="k")',
        '    digest = signer.sign(order_id)',
        '    if not digest:',
        '        raise ValueError("missing digest")',
        '    draft_meta = {"order_id": order_id, "sig": digest}'
    ].join('\n');

    const activity = analyzeImportSymbolActivity(codePrefix, importBlock, 'settlement/service.py', {
        immediateLineWindow: 5
    });

    assert.equal(activity.bindings.length, 3);
    assert.deepEqual(
        activity.immediateCursorBindings.map((b) => b.exportedName),
        ['PayloadSigner']
    );
    assert.deepEqual(
        activity.unusedStagedBindings.map((b) => b.exportedName),
        ['InvoiceBuilder']
    );
    assert.deepEqual(
        activity.earlierOnlyBindings.map((b) => b.exportedName),
        ['AuditLogger']
    );
    assert.equal(activity.hasActiveCursorImport, true);
});

test('AST Chunker v1.2.3: analyzeImportSymbolActivity handles Java unused staged vs earlier imports', () => {
    const javaImports = [
        'import com.acme.cache.LruCache;',
        'import com.acme.codec.VarintEncoder;',
        'import static com.acme.util.Preconditions.checkArgument;'
    ].join('\n');

    const javaPrefix = [
        'public class PacketWriter {',
        '    private final LruCache cache = new LruCache(64);',
        '',
        '    public void reset() {',
        '        cache.clear();',
        '    }',
        '',
        '    public byte[] encodeHeader(int length, int flags) {',
        '        int safeLen = Math.max(0, length);',
        '        int maskedFlags = flags & 0xFF;',
        '        byte[] header = new byte[8];',
        '        header[0] = (byte) maskedFlags;'
    ].join('\n');

    const activity = analyzeImportSymbolActivity(javaPrefix, javaImports, 'PacketWriter.java', {
        immediateLineWindow: 5
    });

    assert.equal(activity.hasActiveCursorImport, false);
    assert.deepEqual(
        activity.earlierOnlyBindings.map((b) => b.exportedName),
        ['LruCache']
    );
    assert.deepEqual(
        activity.unusedStagedBindings.map((b) => b.exportedName),
        ['VarintEncoder', 'checkArgument']
    );
});

test('AST Chunker v1.2.3: supports Java @interface, inline comments in multiline Python imports, and 1-hop receiver activity', () => {
    const javaAnnot = [
        'package com.acme.meta;',
        'public @interface RateLimited {',
        '    int requestsPerMinute();',
        '}'
    ].join('\n');
    const parsedAnnot = extractSymbolsAndImports(javaAnnot, 'RateLimited.java');
    assert.ok(parsedAnnot.symbols.some((s) => s.type === 'type' && s.name === 'RateLimited'));
    assert.ok(parsedAnnot.symbols.some((s) => s.type === 'method' && s.name === 'RateLimited.requestsPerMinute'));

    const pyImports = [
        'from storage.cache import (',
        '    SegmentedCache as SC,  # inline comment must not swallow next line',
        '    ColdArchiveWriter,',
        ')'
    ].join('\n');
    const pyCode = [
        'class SyncEngine:',
        '    def __init__(self):',
        '        self.hot_cache = SC(capacity=256)',
        '        self.ready = True',
        '',
        '    def read_block(self, key: str):',
        '        normalized = key.strip()',
        '        if not normalized:',
        '            return None',
        '        cached = self.hot_cache.lookup(normalized)'
    ].join('\n');

    const act = analyzeImportSymbolActivity(pyCode, pyImports, 'engine.py', { immediateLineWindow: 4 });
    assert.equal(act.bindings.length, 2);
    assert.deepEqual(act.immediateCursorBindings.map((b) => b.exportedName), ['SegmentedCache']);
    assert.equal(act.immediateCursorBindings[0].matchedViaReceiver, true);
    assert.deepEqual(act.unusedStagedBindings.map((b) => b.exportedName), ['ColdArchiveWriter']);
});
