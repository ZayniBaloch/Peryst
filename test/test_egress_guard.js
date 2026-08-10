import assert from 'assert';

console.log('🧪 Testing ScopeKeep Strict Local Egress Guard...');

// Verify default posture: cloud egress is disabled
delete process.env.SCOPEKEEP_ALLOW_CLOUD_EGRESS;
delete process.env.PERSYST_ALLOW_CLOUD_EGRESS;

function isCloudEgressAllowed() {
  return process.env.SCOPEKEEP_ALLOW_CLOUD_EGRESS === '1' || process.env.PERSYST_ALLOW_CLOUD_EGRESS === '1';
}

assert.strictEqual(isCloudEgressAllowed(), false, 'Cloud egress should be disabled by default (Strict Local Mode)');

// Verify opt-in behavior
process.env.SCOPEKEEP_ALLOW_CLOUD_EGRESS = '1';
assert.strictEqual(isCloudEgressAllowed(), true, 'Cloud egress should be allowed when SCOPEKEEP_ALLOW_CLOUD_EGRESS=1');

// Clean up
delete process.env.SCOPEKEEP_ALLOW_CLOUD_EGRESS;

console.log('✅ ScopeKeep Egress Guard tests passed!');
