#!/bin/bash
set -e

# ============================================
# StealthSol Groth16 Trusted Setup
# ============================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CIRCUITS_DIR="$SCRIPT_DIR/.."
BUILD_DIR="$CIRCUITS_DIR/build"
CIRCOM_DIR="$CIRCUITS_DIR/circom"

PTAU_URL="https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_20.ptau"
PTAU_FILE="$BUILD_DIR/powersOfTau28_hez_final_20.ptau"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

check_dependencies() {
    log_info "Checking dependencies..."
    command -v node &> /dev/null || { log_error "Node.js required"; exit 1; }
    command -v circom &> /dev/null || { log_error "circom required: npm i -g circom"; exit 1; }
    command -v snarkjs &> /dev/null || { log_error "snarkjs required: npm i -g snarkjs"; exit 1; }
    log_info "All dependencies found"
}

download_ptau() {
    mkdir -p "$BUILD_DIR"
    if [ -f "$PTAU_FILE" ]; then
        log_info "Powers of Tau already downloaded"
        return
    fi
    log_info "Downloading Powers of Tau (~1GB)..."
    curl -L -o "$PTAU_FILE" "$PTAU_URL"
    log_info "Powers of Tau downloaded"
}

install_circomlib() {
    if [ -d "$CIRCOM_DIR/node_modules/circomlib" ]; then
        log_info "circomlib already installed"
        return
    fi
    log_info "Installing circomlib..."
    cd "$CIRCOM_DIR"
    [ ! -f "package.json" ] && echo '{"dependencies": {"circomlib": "^2.0.5"}}' > package.json
    npm install
    cd "$SCRIPT_DIR"
}

compile_circuit() {
    local name=$1
    local output_dir="$BUILD_DIR/$name"
    log_info "Compiling $name..."
    mkdir -p "$output_dir"
    circom "$CIRCOM_DIR/${name}.circom" --r1cs --wasm --sym -o "$output_dir" -l "$CIRCOM_DIR/node_modules"
    log_info "$name compiled"
}

phase2_setup() {
    local name=$1
    local output_dir="$BUILD_DIR/$name"
    log_info "Phase 2 setup for $name..."
    
    snarkjs groth16 setup "$output_dir/${name}.r1cs" "$PTAU_FILE" "$output_dir/${name}_0000.zkey"
    snarkjs zkey contribute "$output_dir/${name}_0000.zkey" "$output_dir/${name}_0001.zkey" \
        --name="StealthSol" -v -e="$(head -c 64 /dev/urandom | xxd -p)"
    snarkjs zkey beacon "$output_dir/${name}_0001.zkey" "$output_dir/${name}_final.zkey" \
        "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" 10 -n="Final"
    snarkjs zkey export verificationkey "$output_dir/${name}_final.zkey" "$output_dir/verification_key.json"
    
    rm -f "$output_dir/${name}_0000.zkey" "$output_dir/${name}_0001.zkey"
    log_info "$name Phase 2 complete"
}

export_solana_vk() {
    local name=$1
    local output_dir="$BUILD_DIR/$name"
    log_info "Exporting Solana VK for $name..."

    node -e "
const fs = require('fs');
const vk = JSON.parse(fs.readFileSync('$output_dir/verification_key.json'));

function hexToBytes(hex) {
    const bytes = [];
    for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.substr(i, 2), 16));
    return bytes;
}

function g1ToBytes(p) {
    const x = BigInt(p[0]).toString(16).padStart(64, '0');
    const y = BigInt(p[1]).toString(16).padStart(64, '0');
    return [...hexToBytes(x), ...hexToBytes(y)];
}

function g2ToBytes(p) {
    const x0 = BigInt(p[0][0]).toString(16).padStart(64, '0');
    const x1 = BigInt(p[0][1]).toString(16).padStart(64, '0');
    const y0 = BigInt(p[1][0]).toString(16).padStart(64, '0');
    const y1 = BigInt(p[1][1]).toString(16).padStart(64, '0');
    return [...hexToBytes(x0), ...hexToBytes(x1), ...hexToBytes(y0), ...hexToBytes(y1)];
}

const solanaVk = {
    alpha: g1ToBytes(vk.vk_alpha_1),
    beta: g2ToBytes(vk.vk_beta_2),
    gamma: g2ToBytes(vk.vk_gamma_2),
    delta: g2ToBytes(vk.vk_delta_2),
    ic: vk.IC.map(g1ToBytes),
};

fs.writeFileSync('$output_dir/verification_key_solana.json', JSON.stringify(solanaVk, null, 2));
console.log('Exported Solana VK');
"
}

deploy_artifacts() {
    local name=$1
    local src_dir="$BUILD_DIR/$name"
    local frontend_dir="$CIRCUITS_DIR/../frontend/public/circuits/groth16/$name"
    local verifier_dir="$CIRCUITS_DIR/../verifier/circuits"

    log_info "Deploying $name artifacts..."

    # Deploy to frontend
    mkdir -p "$frontend_dir"
    cp -r "$src_dir/${name}_js" "$frontend_dir/" 2>/dev/null || true
    cp "$src_dir/${name}_final.zkey" "$frontend_dir/"
    cp "$src_dir/verification_key.json" "$frontend_dir/"
    log_info "  -> Frontend: $frontend_dir"

    # Deploy to verifier
    mkdir -p "$verifier_dir"
    cp "$src_dir/verification_key.json" "$verifier_dir/${name}_verification_key.json"
    log_info "  -> Verifier: $verifier_dir/${name}_verification_key.json"

    # Deploy Solana VK to program data
    local solana_dir="$CIRCUITS_DIR/../programs/stealth/data"
    mkdir -p "$solana_dir"
    cp "$src_dir/verification_key_solana.json" "$solana_dir/${name}_vk.json"
    log_info "  -> Solana: $solana_dir/${name}_vk.json"
}

setup_circuit() {
    local name=$1
    log_info "======== Setting up $name ========"
    compile_circuit "$name"
    phase2_setup "$name"
    export_solana_vk "$name"
    deploy_artifacts "$name"
}

main() {
    local target=\${1:-all}
    echo "StealthSol Groth16 Setup"
    check_dependencies
    install_circomlib
    download_ptau
    
    case \$target in
        withdraw) setup_circuit "withdraw" ;;
        deposit) setup_circuit "deposit" ;;
        all) setup_circuit "withdraw"; setup_circuit "deposit" ;;
        *) log_error "Usage: \$0 [withdraw|deposit|all]"; exit 1 ;;
    esac
    
    log_info "Setup complete!"
}

main "\$@"
