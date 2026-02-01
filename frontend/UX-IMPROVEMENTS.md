# StealthSol UI/UX Improvements

## Overview
This document outlines UI/UX improvements to make the privacy protocol more accessible to average users without changing the underlying functionality.

## Current Pain Points

| Issue | Problem |
|-------|---------|
| Technical jargon | "Shield", "Stealth", "TEE", "Nullifier" confuse users |
| Manual note codes | Users must copy/save `swn:...` manually - easy to lose |
| Separate flows | Deposit and withdraw are disconnected steps |
| No guidance | New users don't know where to start |
| Hidden privacy info | Users don't understand what's actually private |

## Improvements Implemented

### 1. Simpler Language
```
Current              →  Simpler
─────────────────────────────────
Shield               →  "Deposit" or "Add to Privacy Pool"
Unshield             →  "Withdraw"
Stealth Address      →  "Private Address"
TEE Relay            →  "Hide My Identity" toggle
Note Code            →  "Withdrawal Key"
Meta-address         →  "Privacy Address"
```

### 2. Auto-Save Notes (No More Lost Funds)
- Notes saved to localStorage automatically after deposit
- "Your Withdrawal Keys" section on home screen
- One-click copy to clipboard
- Delete after successful withdrawal
- Warning before deleting unused keys

### 3. Unified "Send Privately" Flow
Streamlined flow that handles deposit + withdrawal:
```
[Send Privately]
  ↓
Enter amount: [1 SOL]
To: [address or "new private wallet"]
  ↓
[Confirm] → Handles deposit + withdrawal automatically
```

### 4. First-Time Onboarding Wizard
```
Step 1: "Create your private identity" [Generate]
Step 2: "Add funds to privacy pool" [Deposit]
Step 3: "You're ready! Send or receive privately"
```

### 5. Visual Privacy Indicator
Real-time privacy score with breakdown:
```
┌─────────────────────────────┐
│  Privacy Level: HIGH        │
│  ✓ Amount hidden            │
│  ✓ Sender hidden            │
│  ✓ Recipient hidden         │
│  ✓ Fee payer hidden         │
└─────────────────────────────┘
```

### 6. Transaction History (Local)
Local-only transaction history (not stored on-chain):
```
Recent Activity
─────────────────
↓ Deposited 1 SOL     2 min ago
↑ Withdrew 1 SOL      just now
  → 9oUcQW...gEZa
```

### 7. Better Empty States
- Guide users when nothing is set up
- Clear call-to-action buttons
- Contextual help text

### 8. Progress Indicators
- Step-by-step progress for multi-step operations
- Clear feedback during ZK proof generation
- Estimated wait times

### 9. Tooltips & Help
- Hover/tap explanations for technical terms
- "What's this?" links to detailed explanations
- Contextual hints

### 10. Mobile-Friendly Touch Targets
- Larger buttons for touch devices
- Swipe gestures where appropriate
- Responsive layout improvements

## Technical Implementation

### Files Modified
- `src/app/page.tsx` - Main UI components
- `src/lib/note-storage.ts` - Local note storage utility (new)
- `src/lib/tx-history.ts` - Local transaction history (new)

### localStorage Keys
- `stealthsol_notes` - Saved withdrawal keys
- `stealthsol_history` - Transaction history
- `stealthsol_onboarded` - Onboarding completion flag
