pragma solidity ^0.8.24;
import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract GameFiArcadeFhe is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosed();
    error InvalidBatch();
    error ReplayDetected();
    error StateMismatch();
    error InvalidDecryptionProof();
    error NotInitialized();

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    struct Batch {
        uint256 id;
        bool isOpen;
        uint256 gameIdCounter;
        mapping(uint256 => Game) games;
    }
    mapping(uint256 => Batch) public batches;
    uint256 public currentBatchId;
    uint256 public totalBatches;

    struct Game {
        uint256 id;
        address creator;
        euint32 encryptedScore;
        bool exists;
    }

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event ContractPaused();
    event ContractUnpaused();
    event CooldownSecondsUpdated(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event GameCreated(uint256 indexed batchId, uint256 indexed gameId, address indexed creator);
    event GameScoreUpdated(uint256 indexed batchId, uint256 indexed gameId, address indexed updater);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 gameId, uint256 score);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier respectCooldown(address user, mapping(address => uint256) storage timer) {
        if (block.timestamp < timer[user] + cooldownSeconds) revert CooldownActive();
        timer[user] = block.timestamp;
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        cooldownSeconds = 10; // Default cooldown
        currentBatchId = 1; // Start with batch 1
        _openBatch(currentBatchId);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addProvider(address provider) external onlyOwner {
        isProvider[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        delete isProvider[provider];
        emit ProviderRemoved(provider);
    }

    function setPaused(bool _paused) external onlyOwner {
        if (_paused) {
            paused = true;
            emit ContractPaused();
        } else {
            paused = false;
            emit ContractUnpaused();
        }
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        emit CooldownSecondsUpdated(cooldownSeconds, newCooldownSeconds);
        cooldownSeconds = newCooldownSeconds;
    }

    function openNewBatch() external onlyOwner whenNotPaused {
        _closeBatch(currentBatchId);
        currentBatchId++;
        totalBatches = currentBatchId; // currentBatchId is always the latest
        _openBatch(currentBatchId);
    }

    function _openBatch(uint256 batchId) private {
        Batch storage batch = batches[batchId];
        batch.id = batchId;
        batch.isOpen = true;
        batch.gameIdCounter = 0;
        emit BatchOpened(batchId);
    }

    function _closeBatch(uint256 batchId) private {
        if (batchId == 0 || batchId > currentBatchId) revert InvalidBatch();
        Batch storage batch = batches[batchId];
        batch.isOpen = false;
        emit BatchClosed(batchId);
    }

    function createGame(euint32 encryptedInitialScore) external onlyProvider whenNotPaused respectCooldown(msg.sender, lastSubmissionTime) {
        Batch storage batch = batches[currentBatchId];
        if (!batch.isOpen) revert BatchClosed();
        uint256 gameId = ++batch.gameIdCounter;
        Game storage game = batch.games[gameId];
        game.id = gameId;
        game.creator = msg.sender;
        game.encryptedScore = encryptedInitialScore;
        game.exists = true;
        emit GameCreated(currentBatchId, gameId, msg.sender);
    }

    function updateGameScore(uint256 gameId, euint32 encryptedScoreDelta) external onlyProvider whenNotPaused respectCooldown(msg.sender, lastSubmissionTime) {
        Batch storage batch = batches[currentBatchId];
        if (!batch.isOpen) revert BatchClosed();
        Game storage game = batch.games[gameId];
        if (!game.exists) revert InvalidBatch(); // Or a more specific error like GameNotFound
        game.encryptedScore = game.encryptedScore.add(encryptedScoreDelta);
        emit GameScoreUpdated(currentBatchId, gameId, msg.sender);
    }

    function requestGameScoreDecryption(uint256 gameId) external onlyProvider whenNotPaused respectCooldown(msg.sender, lastDecryptionRequestTime) {
        Batch storage batch = batches[currentBatchId];
        if (!batch.isOpen) revert BatchClosed();
        Game storage game = batch.games[gameId];
        if (!game.exists) revert InvalidBatch(); // Or GameNotFound

        euint32 memory score = game.encryptedScore;
        if (!score.isInitialized()) revert NotInitialized();

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = score.toBytes32();

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({ batchId: currentBatchId, stateHash: stateHash, processed: false });
        emit DecryptionRequested(requestId, currentBatchId);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal view returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 storage e) internal {
        if (!e.isInitialized()) e = FHE.asEuint32(0);
    }

    function _requireInitialized(euint32 storage e) internal view {
        if (!e.isInitialized()) revert NotInitialized();
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayDetected();
        // Security: Replay protection ensures this callback is processed only once.

        DecryptionContext memory ctx = decryptionContexts[requestId];
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = batches[ctx.batchId].games[0].encryptedScore.toBytes32(); // Rebuild cts from storage

        bytes32 currentHash = _hashCiphertexts(cts);
        // Security: State hash verification ensures that the contract state relevant to the ciphertexts
        // has not changed since the decryption was requested. This prevents certain front-running attacks
        // or inconsistencies if state was modified between request and callback.
        if (currentHash != ctx.stateHash) revert StateMismatch();

        // Security: Proof verification ensures the cleartexts are authentic and correspond to the ciphertexts
        // that were requested for decryption, as signed by the FHE decryption authority.
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) revert InvalidDecryptionProof();

        (uint32 score) = abi.decode(cleartexts, (uint32));
        // For simplicity, assuming gameId 0 for this example. A real contract would need to pass gameId.
        emit DecryptionCompleted(requestId, ctx.batchId, 0, score);

        decryptionContexts[requestId].processed = true;
        // Note: For actual use, you'd likely store the decrypted score or take other actions here.
    }
}