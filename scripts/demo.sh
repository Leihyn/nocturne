#!/bin/bash
# StealthSol Distributed Privacy System Demo
#
# This script demonstrates the full distributed privacy system:
# 1. DKG ceremony for coordinator key shares
# 2. Starting distributed coordinators (3 nodes)
# 3. Starting threshold verifiers (3 nodes)
# 4. Example privacy pool deposit/withdraw flow

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

print_header() {
    echo ""
    echo -e "${CYAN}════════════════════════════════════════════════════════${NC}"
    echo -e "${CYAN}  $1${NC}"
    echo -e "${CYAN}════════════════════════════════════════════════════════${NC}"
    echo ""
}

print_status() {
    echo -e "${BLUE}[*]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[✓]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[!]${NC} $1"
}

print_error() {
    echo -e "${RED}[✗]${NC} $1"
}

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Configuration
COORDINATOR_THRESHOLD=2
COORDINATOR_TOTAL=3
VERIFIER_THRESHOLD=2
VERIFIER_TOTAL=3

# ============================================
# Check Prerequisites
# ============================================

check_prerequisites() {
    print_header "Checking Prerequisites"

    local missing=0

    # Check Docker
    if command -v docker &> /dev/null; then
        print_success "Docker: $(docker --version)"
    else
        print_error "Docker not found"
        missing=1
    fi

    # Check Docker Compose
    if command -v docker-compose &> /dev/null || docker compose version &> /dev/null; then
        print_success "Docker Compose: available"
    else
        print_error "Docker Compose not found"
        missing=1
    fi

    # Check Node.js
    if command -v node &> /dev/null; then
        print_success "Node.js: $(node --version)"
    else
        print_error "Node.js not found"
        missing=1
    fi

    # Check if circuits exist
    if [ -f "$PROJECT_ROOT/circuits/circom/withdraw.circom" ]; then
        print_success "Circom circuits: found"
    else
        print_warning "Circom circuits: not found (will use mock verification)"
    fi

    if [ $missing -eq 1 ]; then
        print_error "Missing prerequisites. Please install them first."
        exit 1
    fi

    print_success "All prerequisites met"
}

# ============================================
# Run DKG Ceremony
# ============================================

run_dkg_ceremony() {
    print_header "Running DKG Ceremony"
    print_status "Generating ${COORDINATOR_THRESHOLD}-of-${COORDINATOR_TOTAL} threshold keys..."

    # Check if DKG script exists
    if [ ! -f "$PROJECT_ROOT/docker/scripts/dkg-ceremony.sh" ]; then
        print_error "DKG ceremony script not found"
        exit 1
    fi

    cd "$PROJECT_ROOT/docker/scripts"
    chmod +x dkg-ceremony.sh
    ./dkg-ceremony.sh $COORDINATOR_THRESHOLD $COORDINATOR_TOTAL

    # Verify keys were generated
    KEYS_DIR="$PROJECT_ROOT/docker/keys"
    if [ -f "$KEYS_DIR/public_key.json" ]; then
        print_success "Public key generated"
        echo "  Location: $KEYS_DIR/public_key.json"
    else
        print_error "Key generation failed"
        exit 1
    fi

    for i in $(seq 1 $COORDINATOR_TOTAL); do
        if [ -f "$KEYS_DIR/key_share_$i.json" ]; then
            print_success "Key share $i generated"
        else
            print_error "Key share $i missing"
            exit 1
        fi
    done

    cd "$PROJECT_ROOT"
}

# ============================================
# Build Docker Images
# ============================================

build_images() {
    print_header "Building Docker Images"

    cd "$PROJECT_ROOT/docker"

    print_status "Building coordinator image..."
    docker build -f coordinator/Dockerfile -t stealthsol-coordinator ..

    print_status "Building verifier image..."
    docker build -f verifier/Dockerfile -t stealthsol-verifier ..

    print_success "Docker images built"
    cd "$PROJECT_ROOT"
}

# ============================================
# Start Services
# ============================================

start_services() {
    print_header "Starting Distributed Services"

    cd "$PROJECT_ROOT/docker"

    print_status "Starting services with docker-compose..."
    docker-compose up -d coordinator-1 coordinator-2 coordinator-3
    docker-compose up -d verifier-1 verifier-2 verifier-3

    print_status "Waiting for services to start..."
    sleep 5

    # Check service health
    check_service_health

    cd "$PROJECT_ROOT"
}

# ============================================
# Check Service Health
# ============================================

check_service_health() {
    print_header "Checking Service Health"

    local all_healthy=1

    # Check coordinators
    for i in 1 2 3; do
        local port=$((8080 + i))
        if curl -s "http://localhost:$port/health" > /dev/null 2>&1; then
            print_success "coordinator-$i: healthy (port $port)"
        else
            print_warning "coordinator-$i: not responding (port $port)"
            all_healthy=0
        fi
    done

    # Check verifiers
    for i in 1 2 3; do
        local port=$((3000 + i))
        if curl -s "http://localhost:$port/health" > /dev/null 2>&1; then
            local nodeId=$(curl -s "http://localhost:$port/health" | grep -o '"nodeId":"[^"]*"' | cut -d'"' -f4)
            print_success "verifier-$i: healthy (port $port, nodeId: $nodeId)"
        else
            print_warning "verifier-$i: not responding (port $port)"
            all_healthy=0
        fi
    done

    if [ $all_healthy -eq 1 ]; then
        print_success "All services are healthy"
    else
        print_warning "Some services are not responding"
    fi
}

# ============================================
# Test Threshold Verification
# ============================================

test_threshold_verification() {
    print_header "Testing Threshold Verification"

    print_status "Sending test verification request to verifier-1..."

    # Create a mock proof request
    local mock_proof=$(echo -n "mock_proof_data_for_testing" | base64)
    local mock_request='{
        "proof": "'$mock_proof'",
        "publicInputs": {
            "merkleRoot": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
            "nullifierHash": "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
            "recipient": "0xrecipient0000000000000000000000000000000000000000000000000000",
            "amount": "1000000000"
        }
    }'

    local response=$(curl -s -X POST \
        -H "Content-Type: application/json" \
        -d "$mock_request" \
        "http://localhost:3001/verify/withdraw" 2>&1)

    if echo "$response" | grep -q '"valid":true'; then
        print_success "Threshold verification successful!"
        echo ""
        echo "Response:"
        echo "$response" | head -20
    elif echo "$response" | grep -q '"error"'; then
        print_warning "Verification returned an error (expected without real proofs)"
        echo "Response: $response"
    else
        print_status "Response: $response"
    fi

    # Check network status
    print_status "Checking verifier network status..."
    curl -s "http://localhost:3001/network" | head -30
}

# ============================================
# Demo Privacy Pool Flow
# ============================================

demo_privacy_pool() {
    print_header "Privacy Pool Demo Flow"

    print_status "This demo shows the conceptual flow of a privacy pool transaction."
    echo ""
    echo "1. USER REGISTRATION"
    echo "   - User generates stealth keypair (scan + spend keys)"
    echo "   - Registers public keys in on-chain registry"
    echo ""
    echo "2. DEPOSIT FLOW"
    echo "   - User generates random nullifier and secret"
    echo "   - Computes commitment = Poseidon(nullifier, secret, amount)"
    echo "   - Generates deposit ZK proof"
    echo "   - Submits proof to threshold verifiers (2-of-3 must verify)"
    echo "   - Sends deposit transaction with verified attestation"
    echo "   - Commitment added to Merkle tree"
    echo ""
    echo "3. COINJOIN COORDINATION"
    echo "   - User connects to distributed coordinator network"
    echo "   - Submits blinded commitment for signature"
    echo "   - Coordinators use threshold RSA (2-of-3)"
    echo "   - User receives blind signature"
    echo "   - User unblinds to get valid output credential"
    echo ""
    echo "4. WITHDRAWAL FLOW"
    echo "   - User generates withdrawal ZK proof proving:"
    echo "     * Knowledge of nullifier and secret"
    echo "     * Commitment is in Merkle tree"
    echo "     * Nullifier hasn't been used"
    echo "   - Submits proof to threshold verifiers"
    echo "   - Receives threshold attestation"
    echo "   - Submits withdrawal transaction"
    echo "   - Nullifier marked as spent"
    echo ""
    echo "PRIVACY GUARANTEES:"
    echo "   - No single party knows the link between deposit and withdrawal"
    echo "   - Threshold verification prevents single point of failure"
    echo "   - CoinJoin coordination shuffles outputs"
    echo "   - ZK proofs hide transaction details"
    echo ""
}

# ============================================
# Show API Examples
# ============================================

show_api_examples() {
    print_header "API Examples"

    echo "VERIFIER API:"
    echo ""
    echo "  # Get verifier info"
    echo "  curl http://localhost:3001/info"
    echo ""
    echo "  # Check network status"
    echo "  curl http://localhost:3001/network"
    echo ""
    echo "  # Verify withdrawal proof"
    echo '  curl -X POST http://localhost:3001/verify/withdraw \'
    echo '    -H "Content-Type: application/json" \'
    echo '    -d '"'"'{"proof":"...", "publicInputs":{...}}'"'"
    echo ""
    echo ""
    echo "COORDINATOR API (WebSocket):"
    echo ""
    echo "  # Connect to coordinator"
    echo "  ws://localhost:8081"
    echo ""
    echo "  # Join session"
    echo '  {"type":"JOIN","denomination":"1000000000"}'
    echo ""
    echo "  # Submit commitment"
    echo '  {"type":"COMMITMENT","blindedCommitment":"..."}'
    echo ""
}

# ============================================
# Stop Services
# ============================================

stop_services() {
    print_header "Stopping Services"

    cd "$PROJECT_ROOT/docker"
    docker-compose down
    print_success "All services stopped"
    cd "$PROJECT_ROOT"
}

# ============================================
# View Logs
# ============================================

view_logs() {
    print_header "Service Logs"

    cd "$PROJECT_ROOT/docker"

    case "${1:-all}" in
        coordinator*)
            docker-compose logs -f coordinator-1 coordinator-2 coordinator-3
            ;;
        verifier*)
            docker-compose logs -f verifier-1 verifier-2 verifier-3
            ;;
        *)
            docker-compose logs -f
            ;;
    esac

    cd "$PROJECT_ROOT"
}

# ============================================
# Main
# ============================================

usage() {
    echo ""
    echo "StealthSol Distributed Privacy System Demo"
    echo ""
    echo "Usage: $0 [command]"
    echo ""
    echo "Commands:"
    echo "  check       Check prerequisites"
    echo "  dkg         Run DKG ceremony for coordinator keys"
    echo "  build       Build Docker images"
    echo "  start       Start all services"
    echo "  health      Check service health"
    echo "  test        Test threshold verification"
    echo "  demo        Show privacy pool demo flow"
    echo "  api         Show API examples"
    echo "  logs        View service logs (coordinator|verifier|all)"
    echo "  stop        Stop all services"
    echo "  all         Run full demo (dkg, build, start, test)"
    echo "  help        Show this help message"
    echo ""
}

main() {
    echo ""
    echo -e "${CYAN}╔════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║       StealthSol Distributed Privacy System Demo       ║${NC}"
    echo -e "${CYAN}╚════════════════════════════════════════════════════════╝${NC}"

    case "${1:-help}" in
        check)
            check_prerequisites
            ;;
        dkg)
            run_dkg_ceremony
            ;;
        build)
            build_images
            ;;
        start)
            start_services
            ;;
        health)
            check_service_health
            ;;
        test)
            test_threshold_verification
            ;;
        demo)
            demo_privacy_pool
            ;;
        api)
            show_api_examples
            ;;
        logs)
            view_logs "$2"
            ;;
        stop)
            stop_services
            ;;
        all)
            check_prerequisites
            run_dkg_ceremony
            build_images
            start_services
            sleep 3
            check_service_health
            test_threshold_verification
            demo_privacy_pool
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
}

main "$@"
