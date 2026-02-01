# StealthSol Usage Guide

StealthSol enables private payments on Solana using stealth addresses. Each payment creates a unique one-time address that only you can link to your identity.

---

## Prerequisites

### 1. Install Solana CLI Tools

```bash
# Install Solana CLI
sh -c "$(curl -sSfL https://release.solana.com/v1.18.26/install)"

# Add to PATH (add to ~/.bashrc or ~/.zshrc)
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Verify installation
solana --version
```

### 2. Install Anchor (for program deployment)

```bash
# Install AVM (Anchor Version Manager)
cargo install --git https://github.com/coral-xyz/anchor avm --locked

# Install Anchor 0.30.1
avm install 0.30.1
avm use 0.30.1
```

### 3. Build StealthSol CLI

```bash
cd /path/to/stealthsol
cargo build --release --package stealth-cli

# Add to PATH or create alias
alias stealthsol='./target/release/stealthsol'
```

---

## Quick Start

### Step 1: Generate Your Keys

```bash
# Generate keys with recovery phrase (recommended)
stealthsol keygen --mnemonic

# Or import from existing mnemonic
stealthsol keygen --import-mnemonic "your 24 word phrase here"
```

This creates:
- **Scan key pair** - For detecting incoming payments
- **Spend key pair** - For spending received funds
- **Meta-address** - Share this publicly to receive payments

**IMPORTANT:** Write down your recovery phrase and store it securely offline!

### Step 2: Configure Solana

```bash
# For devnet (testing)
solana config set --url https://api.devnet.solana.com

# Create a Solana wallet if you don't have one
solana-keygen new

# Get devnet SOL for testing
solana airdrop 2
```

### Step 3: Register On-Chain

```bash
# Register your meta-address on Solana
stealthsol register
```

This creates a registry account so others can look up your meta-address.

### Step 4: Share Your Meta-Address

```bash
# View your address
stealthsol address
```

Output:
```
Meta-Address (share this to receive payments):
  stealth:2xK9...abc123
```

Share this `stealth:...` address with anyone who wants to send you private payments.

---

## Receiving Payments

### Scan for Incoming Payments

```bash
# Check for new payments
stealthsol scan
```

Output:
```
Scanning for stealth payments...
Found 2 payments:

Payment 1:
  Stealth Address: 7xAbc...
  Amount: 0.5 SOL
  Received: 2024-01-15 14:30:00

Payment 2:
  Stealth Address: 9yDef...
  Amount: 1.0 SOL
  Received: 2024-01-15 15:45:00

Total: 1.5 SOL across 2 stealth addresses
```

### Withdraw Funds

```bash
# Withdraw from a specific stealth address
stealthsol withdraw --address 7xAbc...

# Or withdraw from all detected payments
stealthsol withdraw --all
```

---

## Sending Payments

### Send to a Meta-Address

```bash
# Send 0.1 SOL to a stealth meta-address
stealthsol send --to stealth:2xK9...abc123 --amount 0.1
```

The CLI will:
1. Derive a unique stealth address for the recipient
2. Transfer SOL to that address
3. Create an announcement so the recipient can detect the payment

### Send to a Registered User

```bash
# Send by looking up their on-chain registry
stealthsol send --recipient <SOLANA_PUBKEY> --amount 0.1
```

---

## Advanced Commands

### Check Balance

```bash
# Show total balance across all stealth addresses
stealthsol balance
```

### Export View Key

```bash
# Export scan-only key (can detect payments but NOT spend)
stealthsol export-view-key
```

Use this for:
- Delegating payment monitoring to a third party
- Running a watch-only wallet
- Accounting without risk of theft

### Show Configuration

```bash
# Display current configuration and key info
stealthsol info
```

---

## Network Configuration

### Devnet (Testing)

```bash
stealthsol --rpc-url https://api.devnet.solana.com <command>
```

### Mainnet (Production)

```bash
stealthsol --rpc-url https://api.mainnet-beta.solana.com <command>
```

### Local Validator

```bash
# Start local validator
solana-test-validator

# In another terminal
stealthsol --rpc-url http://localhost:8899 <command>
```

---

## Running a Local Test Environment

### 1. Start Local Validator

```bash
solana-test-validator --reset
```

### 2. Deploy the Program

```bash
# Build the program
anchor build

# Deploy to local validator
anchor deploy --provider.cluster localnet
```

### 3. Test the Full Flow

```bash
# Terminal 1: Alice generates keys and registers
stealthsol --rpc-url http://localhost:8899 keygen --mnemonic
stealthsol --rpc-url http://localhost:8899 register
stealthsol --rpc-url http://localhost:8899 address
# Note the meta-address: stealth:...

# Terminal 2: Bob sends to Alice
solana airdrop 5 --url http://localhost:8899
stealthsol --rpc-url http://localhost:8899 send --to stealth:... --amount 1

# Terminal 1: Alice scans and withdraws
stealthsol --rpc-url http://localhost:8899 scan
stealthsol --rpc-url http://localhost:8899 withdraw --all
```

---

## Security Best Practices

### Key Management

1. **Always use a mnemonic** - Enables key recovery
2. **Use a strong password** - 12+ characters, mixed case, numbers, symbols
3. **Store mnemonic offline** - Never store digitally
4. **Test recovery** - Verify you can restore from mnemonic before receiving funds

### Operational Security

1. **Use Tor/VPN** when scanning for payments
2. **Don't reuse stealth addresses** - Each should only receive one payment
3. **Withdraw promptly** - Reduces exposure time
4. **Consider hardware wallet** integration for high-value use

### View Key Delegation

If you share your view key:
- Third party can see all incoming payments
- Third party CANNOT spend funds
- Useful for accounting, auditing, monitoring

---

## Troubleshooting

### "No stealth keys found"

```bash
stealthsol keygen --mnemonic
```

### "Insufficient funds"

```bash
# Check your Solana balance
solana balance

# Get devnet SOL
solana airdrop 2
```

### "Registry not found"

The recipient hasn't registered their meta-address. Ask them to:
```bash
stealthsol register
```

Or send directly to their meta-address (no registry lookup):
```bash
stealthsol send --to stealth:... --amount 0.1
```

### "Transaction failed"

1. Check RPC URL is correct
2. Verify you have enough SOL for fees
3. Try again (network congestion)

---

## Command Reference

| Command | Description |
|---------|-------------|
| `keygen` | Generate stealth key pairs |
| `register` | Register meta-address on-chain |
| `address` | Show your meta-address |
| `send` | Send SOL privately |
| `scan` | Detect incoming payments |
| `withdraw` | Withdraw received funds |
| `balance` | Show total stealth balance |
| `export-view-key` | Export scan-only key |
| `info` | Show configuration |

---

## Program Deployment (For Developers)

### Deploy to Devnet

```bash
# Configure for devnet
solana config set --url https://api.devnet.solana.com

# Build
anchor build

# Deploy
anchor deploy

# Note the program ID and update lib.rs if needed
```

### Deploy to Mainnet

```bash
# Configure for mainnet
solana config set --url https://api.mainnet-beta.solana.com

# Ensure you have SOL for deployment (~3 SOL)
solana balance

# Deploy
anchor deploy --provider.cluster mainnet
```

---

## Support

- Issues: https://github.com/your-repo/stealthsol/issues
- Documentation: See `SECURITY_ANALYSIS.md` for security details
