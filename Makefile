# StealthSol Makefile
# Convenience commands for development

.PHONY: all build build-program build-cli test test-program test-cli clean deploy setup help

# Default target
all: build test

# Build everything
build: build-program build-cli

# Build the Anchor program (DEV MODE - no ZK verification)
build-program:
	@echo "Building Anchor program (DEV MODE)..."
	@echo "WARNING: ZK proof verification is DISABLED in dev mode!"
	anchor build

# Build the Anchor program for PRODUCTION (real ZK verification)
build-production:
	@echo "Building Anchor program (PRODUCTION MODE)..."
	@echo "ZK proof verification via oracle attestations ENABLED"
	anchor build -- --features production

# Build everything for production
build-all-production: build-production build-cli
	@echo "Production build complete!"

# Build the CLI
build-cli:
	@echo "Building CLI..."
	cd cli && cargo build --release

# Run all tests
test: test-program test-cli

# Run program tests
test-program:
	@echo "Running program tests..."
	cd programs/stealth && cargo test

# Run CLI tests
test-cli:
	@echo "Running CLI tests..."
	cd cli && cargo test

# Run tests with output
test-verbose:
	cd programs/stealth && cargo test -- --nocapture
	cd cli && cargo test -- --nocapture

# Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	anchor clean
	cd cli && cargo clean

# Deploy to devnet (PRODUCTION MODE - recommended)
deploy:
	@echo "Building for production..."
	$(MAKE) build-production
	@echo "Deploying to devnet (PRODUCTION MODE)..."
	anchor deploy --provider.cluster devnet

# Deploy to devnet (DEV MODE - testing only, no ZK verification)
deploy-dev:
	@echo "WARNING: Deploying in DEV MODE - ZK verification DISABLED!"
	@echo "This should ONLY be used for testing!"
	anchor build
	anchor deploy --provider.cluster devnet

# Deploy to localnet (DEV MODE for local testing)
deploy-local:
	@echo "Deploying to localnet (DEV MODE)..."
	anchor deploy --provider.cluster localnet

# Deploy to mainnet (PRODUCTION MODE REQUIRED)
deploy-mainnet:
	@echo "Building for MAINNET production..."
	$(MAKE) build-production
	@echo "Deploying to mainnet..."
	anchor deploy --provider.cluster mainnet

# Start local validator
localnet:
	@echo "Starting local validator..."
	solana-test-validator --reset

# Setup development environment
setup:
	./scripts/setup.sh all

# Install dependencies only
install:
	./scripts/setup.sh install

# Request devnet airdrop
airdrop:
	solana airdrop 2 --url devnet

# Check Solana balance
balance:
	solana balance --url devnet

# Format code
fmt:
	cd programs/stealth && cargo fmt
	cd cli && cargo fmt

# Lint code
lint:
	cd programs/stealth && cargo clippy -- -D warnings
	cd cli && cargo clippy -- -D warnings

# Generate IDL
idl:
	anchor build
	@echo "IDL generated at target/idl/stealth.json"

# Show program logs (requires deployed program)
logs:
	solana logs --url devnet | grep -i stealth

# Keygen (generate stealth keys using CLI)
keygen:
	./target/release/stealthsol keygen

# Start verifier service
verifier:
	@echo "Starting ZK verifier service..."
	cd verifier && npm start

# Start verifier in development mode
verifier-dev:
	@echo "Starting ZK verifier service (dev mode with watch)..."
	cd verifier && npm run dev

# Install verifier dependencies
verifier-install:
	@echo "Installing verifier dependencies..."
	cd verifier && npm install

# ============================================
# Docker / Distributed System
# ============================================

# Run DKG ceremony
dkg:
	@echo "Running DKG ceremony..."
	chmod +x docker/scripts/dkg-ceremony.sh
	cd docker/scripts && ./dkg-ceremony.sh 2 3

# Build Docker images
docker-build:
	@echo "Building Docker images..."
	cd docker && docker-compose build

# Start distributed services
docker-up:
	@echo "Starting distributed services..."
	cd docker && docker-compose up -d

# Stop distributed services
docker-down:
	@echo "Stopping distributed services..."
	cd docker && docker-compose down

# View Docker logs
docker-logs:
	cd docker && docker-compose logs -f

# View coordinator logs
docker-logs-coordinator:
	cd docker && docker-compose logs -f coordinator-1 coordinator-2 coordinator-3

# View verifier logs
docker-logs-verifier:
	cd docker && docker-compose logs -f verifier-1 verifier-2 verifier-3

# Check service health
docker-health:
	@echo "Checking service health..."
	@curl -s http://localhost:3001/health 2>/dev/null | head -1 || echo "verifier-1: offline"
	@curl -s http://localhost:3002/health 2>/dev/null | head -1 || echo "verifier-2: offline"
	@curl -s http://localhost:3003/health 2>/dev/null | head -1 || echo "verifier-3: offline"

# Full demo
demo:
	@echo "Running full demo..."
	chmod +x scripts/demo.sh
	./scripts/demo.sh all

# Quick demo check
demo-check:
	./scripts/demo.sh check

# Integration tests
integration-test:
	@echo "Running integration tests..."
	cd scripts && node integration-test.js all

# ============================================
# Circuit Setup (Groth16)
# ============================================

# Setup circuits (requires circom)
circuits-setup:
	@echo "Setting up ZK circuits..."
	@echo "This will download Powers of Tau (~1GB) and compile circuits"
	chmod +x circuits/scripts/setup.sh
	cd circuits/scripts && ./setup.sh

# Clean circuit artifacts
circuits-clean:
	@echo "Cleaning circuit artifacts..."
	rm -rf circuits/build/*
	rm -rf frontend/public/circuits/groth16

# Install circuit dependencies
circuits-deps:
	@echo "Installing circuit dependencies..."
	npm install -g circom snarkjs
	cd circuits/circom && npm install

# Initialize verification keys on Solana
init-vk:
	@echo "Initializing verification keys on Solana..."
	cd scripts && npm install && npx ts-node init-vk.ts devnet

init-vk-mainnet:
	@echo "Initializing verification keys on mainnet..."
	cd scripts && npm install && npx ts-node init-vk.ts mainnet

# ============================================
# Full Production Setup
# ============================================

# Complete production setup (all steps)
production-setup: circuits-deps circuits-setup build-production deploy init-vk docker-build
	@echo ""
	@echo "Production setup complete!"
	@echo ""
	@echo "Next steps:"
	@echo "  1. Start distributed services: make docker-up"
	@echo "  2. Run frontend: cd frontend && npm run dev"
	@echo "  3. Users can now make real deposits and withdrawals!"
	@echo ""

# Show help
help:
	@echo "StealthSol Development Commands"
	@echo ""
	@echo "Build:"
	@echo "  make build             - Build program (DEV) and CLI"
	@echo "  make build-program     - Build Anchor program (DEV MODE)"
	@echo "  make build-production  - Build Anchor program (PRODUCTION MODE)"
	@echo "  make build-cli         - Build CLI only"
	@echo ""
	@echo "Test:"
	@echo "  make test              - Run all tests"
	@echo "  make test-program      - Run program tests only"
	@echo "  make test-cli          - Run CLI tests only"
	@echo "  make test-verbose      - Run tests with output"
	@echo "  make integration-test  - Run distributed system integration tests"
	@echo ""
	@echo "Deploy:"
	@echo "  make deploy            - Deploy to devnet (PRODUCTION)"
	@echo "  make deploy-dev        - Deploy to devnet (DEV - no ZK verify)"
	@echo "  make deploy-mainnet    - Deploy to mainnet (PRODUCTION)"
	@echo "  make deploy-local      - Deploy to localnet (DEV)"
	@echo "  make localnet          - Start local validator"
	@echo ""
	@echo "Distributed System (Docker):"
	@echo "  make dkg               - Run DKG ceremony for coordinator keys"
	@echo "  make docker-build      - Build Docker images"
	@echo "  make docker-up         - Start distributed services"
	@echo "  make docker-down       - Stop distributed services"
	@echo "  make docker-logs       - View service logs"
	@echo "  make docker-health     - Check service health"
	@echo "  make demo              - Run full demo"
	@echo ""
	@echo "ZK Circuits:"
	@echo "  make circuits-deps     - Install circom and snarkjs"
	@echo "  make circuits-setup    - Compile circuits and run trusted setup"
	@echo "  make circuits-clean    - Clean circuit artifacts"
	@echo "  make init-vk           - Initialize VKs on Solana (devnet)"
	@echo "  make init-vk-mainnet   - Initialize VKs on Solana (mainnet)"
	@echo ""
	@echo "Production:"
	@echo "  make production-setup  - Full setup (circuits + deploy + docker)"
	@echo ""
	@echo "Verifier Service:"
	@echo "  make verifier          - Start ZK verifier service"
	@echo "  make verifier-dev      - Start verifier with hot reload"
	@echo "  make verifier-install  - Install verifier dependencies"
	@echo ""
	@echo "Development:"
	@echo "  make setup             - Full environment setup"
	@echo "  make install           - Install dependencies"
	@echo "  make clean             - Clean build artifacts"
	@echo "  make fmt               - Format code"
	@echo "  make lint              - Run linter"
	@echo ""
	@echo "Utilities:"
	@echo "  make airdrop           - Request devnet SOL"
	@echo "  make balance           - Check wallet balance"
	@echo "  make keygen            - Generate stealth keys"
	@echo "  make logs              - Show program logs"
	@echo ""
	@echo "IMPORTANT: Use 'make deploy' for devnet/mainnet (enables ZK verification)"
	@echo "           Use 'make deploy-dev' only for local testing"
