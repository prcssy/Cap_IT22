/**
 * set-password-policy.cjs
 *
 * Turns on Firebase Authentication's server-side password policy so the
 * same rule the sign-up form checks (8+ characters, uppercase, lowercase,
 * a number — see src/shared/utils/validation.js) is also enforced by
 * Firebase itself. Without it, the rule lives only in the browser and
 * could be skipped by calling the Firebase Auth REST API directly.
 *
 * Existing accounts are not locked out: forceUpgradeOnSignin is false, so
 * an older weaker password still signs in; only NEW passwords (sign-up,
 * password change/reset) must meet the policy.
 *
 * ─── SETUP ─────────────────────────────────────────────────────────
 * Needs serviceAccountKey.json in this folder (gitignored).
 *
 * ─── USAGE ─────────────────────────────────────────────────────────
 *   node set-password-policy.cjs         # dry run: shows the current policy
 *   node set-password-policy.cjs --yes   # applies the policy
 */

const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

const POLICY = {
  enforcementState: 'ENFORCE',
  forceUpgradeOnSignin: false,
  constraints: {
    minLength: 8,
    requireUppercase: true,
    requireLowercase: true,
    requireNumeric: true,
    requireNonAlphanumeric: false,
  },
};

async function main() {
  initializeApp({ credential: cert(require(path.join(__dirname, 'serviceAccountKey.json'))) });
  const manager = getAuth().projectConfigManager();

  const current = await manager.getProjectConfig();
  console.log('Current password policy:', JSON.stringify(current.passwordPolicyConfig || 'none', null, 2));

  if (!process.argv.includes('--yes')) {
    console.log('\nDry run. Re-run with --yes to apply:', JSON.stringify(POLICY, null, 2));
    return;
  }

  const updated = await manager.updateProjectConfig({ passwordPolicyConfig: POLICY });
  console.log('\nApplied:', JSON.stringify(updated.passwordPolicyConfig, null, 2));
}

main().catch((err) => {
  console.error('Failed:', err.message || err);
  process.exit(1);
});
