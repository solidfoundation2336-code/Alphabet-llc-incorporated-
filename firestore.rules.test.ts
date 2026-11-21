import assert from 'node:assert/strict';
import fs from 'node:fs';

const rulesText = fs.readFileSync('firestore.rules', 'utf8');

// Structural & Eight-Pillar Assertions for the Dirty Dozen
function verifyRulesCompliance() {
  assert.ok(rulesText.includes("rules_version = '2';"), 'Must enforce rules_version 2');
  assert.ok(rulesText.includes('match /{document=**} {\n      allow read, write: if false;\n    }'), 'Must have default-deny safety net');
  assert.ok(rulesText.includes('request.auth.token.email_verified == true'), 'Must enforce verified users');
  assert.ok(!rulesText.includes('allow list: if isSignedIn();'), 'Must never delegate list filtering to client');
  assert.ok(rulesText.includes('existsAfter(/databases/$(database)/documents/bank_accounts/'), 'Must enforce relational account integrity');
  assert.ok(rulesText.includes("existing().status != 'approved'"), 'Must lock terminal DTC approved state');
  assert.ok(rulesText.includes("existing().status == 'pending_mfa'"), 'Must lock terminal payment state');
  assert.ok(rulesText.includes("existing().custodyStatus != 'archived'"), 'Must lock terminal archived asset state');
  assert.ok(rulesText.includes("incoming().custodyStatus == 'pending_verification'"), 'Must prevent state-shortcutting assets on create');
  assert.ok(rulesText.includes('data.regulations.size() <= 10'), 'Must bound regulations array size');
  assert.ok(rulesText.includes('incoming().createdAt == request.time'), 'Must enforce server request.time on create');
  assert.ok(rulesText.includes("docId == 'recovery'"), 'Must isolate account recovery under private subcollection');
  assert.ok(rulesText.includes('isValidAccountRecoveryConfig'), 'Must validate account recovery schema');
  assert.ok(rulesText.includes('isValidBankTxArchitecture'), 'Must validate bank transaction architecture schema');
  assert.ok(rulesText.includes('isValidBrokerageTxArchitecture'), 'Must validate brokerage transaction architecture schema');
  assert.ok(rulesText.includes('isValidRailArchitecture'), 'Must validate rail architecture schema');
  assert.ok(rulesText.includes('isValidCompanyAccount'), 'Must validate company account schema');
  assert.ok(rulesText.includes('isValidPublicAccount'), 'Must validate public account schema');
  assert.ok(rulesText.includes("'company', 'public'"), 'Must allow company and public bank account types');
  assert.ok(rulesText.includes("existing().status != 'dissolved'"), 'Must lock terminal dissolved company account state');
  assert.ok(rulesText.includes("existing().status != 'archived'"), 'Must lock terminal archived public account state');
  assert.ok(rulesText.includes('isValidStagedAsset'), 'Must validate staged asset schema');
  assert.ok(rulesText.includes("incoming().reviewStatus == 'pending_review'"), 'Must force staged assets to start in pending_review');
  assert.ok(rulesText.includes("existing().reviewStatus != 'committed'"), 'Must lock terminal committed staged asset state');
  assert.ok(rulesText.includes('data.nameVerified == true && data.identifierVerified == true && data.valuationVerified == true'), 'Must enforce field verification prior to verify/commit');
  assert.ok(rulesText.includes('data.rawDocumentText.size() <= 8000'), 'Must bound rawDocumentText size');
  assert.ok(rulesText.includes('data.sourceExcerpt.size() <= 800'), 'Must bound sourceExcerpt size');
  assert.ok(rulesText.includes('existsAfter(/databases/$(database)/documents/brokerage_firms/'), 'Must enforce relational brokerage firm integrity');
  assert.ok(rulesText.includes('isValidAcquisitionArchitecture'), 'Must validate acquisition architecture schema');
  assert.ok(rulesText.includes("incoming().stage in ['pipeline', 'diligence']"), 'Must prevent state-shortcutting acquisition architectures on create');
  assert.ok(rulesText.includes("!(existing().stage in ['closed', 'cancelled'])"), 'Must lock terminal closed/cancelled acquisition stage');
  assert.ok(rulesText.includes("'purchases'"), 'Must allow purchases bank account type');
  assert.ok(rulesText.includes("'purchasesAccountId'"), 'Must support designated purchasesAccountId on UserWorkspace');
  assert.ok(rulesText.includes('existsAfter(/databases/$(database)/documents/payments/$(incoming().escrowPaymentId))'), 'Must enforce relational escrow payment integrity on acquisition workflow');
  assert.ok(rulesText.includes('existsAfter(/databases/$(database)/documents/assets/$(incoming().onboardedAssetId))'), 'Must enforce relational onboarded asset integrity on acquisition workflow');
  assert.ok(rulesText.includes('isValidBrokerageAccount'), 'Must validate brokerage account schema');
  assert.ok(rulesText.includes("existing().status != 'closed'"), 'Must lock terminal closed brokerage account state');
  assert.ok(rulesText.includes('existsAfter(/databases/$(database)/documents/brokerage_accounts/$(incoming().brokerageAccountId))'), 'Must enforce relational brokerage account integrity on onboarded assets');

  // Verify every collection in firebase-blueprint.json has a matching rule block
  const blueprint = JSON.parse(fs.readFileSync('firebase-blueprint.json', 'utf8'));
  const expectedCollections = Object.keys(blueprint.firestore).map((p) => p.split('/')[1]);
  for (const col of expectedCollections) {
    assert.ok(rulesText.includes(`match /${col}/`), `Missing security rule block for ${col}`);
  }
  console.log('All Dirty Dozen security rule invariants and blueprint coverage checks passed.');
}

verifyRulesCompliance();
