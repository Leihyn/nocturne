#!/bin/bash
# StealthSol Development Environment Setup Script
# This script installs all dependencies needed to build and test StealthSol

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_status() {
    echo -e "${BLUE}[*]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[+]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[!]${NC} $1"
}

print_error() {
    echo -e "${RED}[-]${NC} $1"
}

# Detect OS
detect_os() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        OS="macos"
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        OS="linux"
    else
        print_error "Unsupported OS: $OSTYPE"
        exit 1
    fi
    print_status "Detected OS: $OS"
}

# Check if command exists
command_exists() {
    command -v "$1" &> /dev/null
}

# Install Rust
install_rust() {
    if command_exists rustc; then
        RUST_VERSION=$(rustc --version)
        print_success "Rust already installed: $RUST_VERSION"
    else
        print_status "Installing Rust..."
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
        source "$HOME/.cargo/env"
        print_success "Rust installed successfully"
    fi

    # Ensure stable toolchain
    print_status "Setting up Rust stable toolchain..."
    rustup default stable
    rustup update stable
}

# Install Solana CLI
install_solana() {
    if command_exists solana; then
        SOLANA_VERSION=$(solana --version)
        print_success "Solana CLI already installed: $SOLANA_VERSION"
    else
        print_status "Installing Solana CLI..."
        sh -c "$(curl -sSfL https://release.anza.xyz/v1.18.26/install)"

        # Add to PATH
        export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

        # Add to shell profile
        SHELL_PROFILE=""
        if [ -f "$HOME/.zshrc" ]; then
            SHELL_PROFILE="$HOME/.zshrc"
        elif [ -f "$HOME/.bashrc" ]; then
            SHELL_PROFILE="$HOME/.bashrc"
        elif [ -f "$HOME/.bash_profile" ]; then
            SHELL_PROFILE="$HOME/.bash_profile"
        fi

        if [ -n "$SHELL_PROFILE" ]; then
            echo 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"' >> "$SHELL_PROFILE"
            print_status "Added Solana to PATH in $SHELL_PROFILE"
        fi

        print_success "Solana CLI installed successfully"
    fi
}

# Install Anchor
install_anchor() {
    if command_exists anchor; then
        ANCHOR_VERSION=$(anchor --version)
        print_success "Anchor already installed: $ANCHOR_VERSION"
    else
        print_status "Installing Anchor Version Manager (avm)..."
        cargo install --git https://github.com/coral-xyz/anchor avm --locked --force

        print_status "Installing Anchor CLI..."
        avm install 0.31.1
        avm use 0.31.1

        print_success "Anchor installed successfully"
    fi
}

# Setup Solana config
setup_solana_config() {
    print_status "Configuring Solana for devnet..."
    solana config set --url devnet

    # Check for keypair
    if [ ! -f "$HOME/.config/solana/id.json" ]; then
        print_status "Generating new Solana keypair..."
        solana-keygen new --no-bip39-passphrase -o "$HOME/.config/solana/id.json"
        print_success "New keypair generated at ~/.config/solana/id.json"
    else
        print_success "Solana keypair already exists"
    fi

    # Show public key
    PUBKEY=$(solana address)
    print_status "Your wallet address: $PUBKEY"
}

# Request airdrop
request_airdrop() {
    print_status "Requesting SOL airdrop on devnet..."
    if solana airdrop 2 2>/dev/null; then
        print_success "Airdrop successful!"
    else
        print_warning "Airdrop failed (rate limited). Request manually: solana airdrop 2"
    fi

    BALANCE=$(solana balance)
    print_status "Current balance: $BALANCE"
}

# Build the project
build_project() {
    print_status "Building the Anchor program..."

    # Navigate to project root
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
    cd "$PROJECT_ROOT"

    if anchor build; then
        print_success "Anchor program built successfully"
    else
        print_error "Anchor build failed"
        return 1
    fi

    print_status "Building the CLI..."
    cd cli
    if cargo build --release; then
        print_success "CLI built successfully"
        print_status "CLI binary location: target/release/stealthsol"
    else
        print_error "CLI build failed"
        return 1
    fi
    cd ..
}

# Run tests
run_tests() {
    print_status "Running program unit tests..."

    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
    cd "$PROJECT_ROOT"

    cd programs/stealth
    if cargo test; then
        print_success "Program tests passed"
    else
        print_error "Program tests failed"
    fi
    cd ../..

    print_status "Running CLI tests..."
    cd cli
    if cargo test; then
        print_success "CLI tests passed"
    else
        print_error "CLI tests failed"
    fi
    cd ..
}

# Deploy to devnet
deploy_devnet() {
    print_status "Deploying program to devnet..."

    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
    cd "$PROJECT_ROOT"

    if anchor deploy --provider.cluster devnet; then
        print_success "Program deployed to devnet!"

        # Show program ID
        PROGRAM_ID=$(solana address -k target/deploy/stealth-keypair.json 2>/dev/null || echo "unknown")
        print_status "Program ID: $PROGRAM_ID"
    else
        print_error "Deployment failed"
        return 1
    fi
}

# Print usage
usage() {
    echo "StealthSol Development Environment Setup"
    echo ""
    echo "Usage: $0 [command]"
    echo ""
    echo "Commands:"
    echo "  install     Install all dependencies (Rust, Solana, Anchor)"
    echo "  config      Configure Solana for devnet and setup keypair"
    echo "  airdrop     Request SOL airdrop on devnet"
    echo "  build       Build the Anchor program and CLI"
    echo "  test        Run all tests"
    echo "  deploy      Deploy program to devnet"
    echo "  all         Run all setup steps (install, config, build, test)"
    echo "  help        Show this help message"
    echo ""
}

# Main
main() {
    echo ""
    echo "========================================"
    echo "   StealthSol Environment Setup"
    echo "========================================"
    echo ""

    detect_os

    case "${1:-all}" in
        install)
            install_rust
            install_solana
            install_anchor
            ;;
        config)
            setup_solana_config
            ;;
        airdrop)
            request_airdrop
            ;;
        build)
            build_project
            ;;
        test)
            run_tests
            ;;
        deploy)
            deploy_devnet
            ;;
        all)
            install_rust
            install_solana
            install_anchor
            setup_solana_config
            request_airdrop
            build_project
            run_tests
            ;;
        help|--help|-h)
            usage
            ;;
        *)
            print_error "Unknown command: $1"
            usage
            exit 1
            ;;
    esac

    echo ""
    print_success "Setup complete!"
    echo ""
}

main "$@"
