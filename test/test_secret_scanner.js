import { scanAndSanitize } from '../src/secret-scanner.js';
import assert from 'assert';

console.log('🧪 Testing ScopeKeep Secret Scanner...');

// 1. AWS Key Detection
const awsText = 'Here is my AWS key: AKIAIOSFODNN7EXAMPLE';
const awsResult = scanAndSanitize(awsText);
assert.strictEqual(awsResult.hasSecrets, true, 'Should detect AWS Key');
assert.ok(awsResult.sanitizedText.includes('[REDACTED_AWS_KEY]'), 'Should redact AWS Key');

// 2. Email Detection
const emailText = 'Contact user at developer@example.com for access.';
const emailResult = scanAndSanitize(emailText);
assert.strictEqual(emailResult.hasSecrets, true, 'Should detect Email');
assert.ok(emailResult.sanitizedText.includes('[REDACTED_EMAIL]'), 'Should redact Email');

// 3. Clean Text
const cleanText = 'The database connection pool size is set to 20.';
const cleanResult = scanAndSanitize(cleanText);
assert.strictEqual(cleanResult.hasSecrets, false, 'Should pass clean text');
assert.strictEqual(cleanResult.sanitizedText, cleanText, 'Text should remain unchanged');

console.log('✅ ScopeKeep Secret Scanner tests passed!');
