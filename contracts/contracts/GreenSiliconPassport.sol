// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {CircularityToken} from "./CircularityToken.sol";

/**
 * @title GreenSiliconPassport
 * @notice Digital Product Passport for semiconductor production lots.
 *
 * Each ERC-721 token is one production lot (wafer lot, die lot or packaged lot).
 * Supply-chain actors append lifecycle stage records (design, wafer fab,
 * assembly, test, logistics, end-of-life) as EIP-712 signed attestations, so a
 * relayer can anchor them without the supplier paying gas, and nobody can forge
 * a record on a supplier's behalf.
 *
 * Privacy: only a Merkle root of the full disclosure is stored on-chain, with
 * salted leaves. Suppliers can later reveal a single field (e.g. scope-1 gas
 * emissions) with a proof, without exposing confidential process data
 * (yield, recipe, tool-level energy).
 *
 * Double counting: embodied carbon of chiplets/components is allocated to the
 * assembled product per unit consumed, and a component lot can never be
 * allocated beyond its unit count. Offsets can never exceed the footprint.
 */
contract GreenSiliconPassport is ERC721, AccessControl, EIP712 {
    bytes32 public constant DESIGNER_ROLE = keccak256("DESIGNER_ROLE");
    bytes32 public constant FAB_ROLE = keccak256("FAB_ROLE");
    bytes32 public constant OSAT_ROLE = keccak256("OSAT_ROLE");
    bytes32 public constant LOGISTICS_ROLE = keccak256("LOGISTICS_ROLE");
    bytes32 public constant RECYCLER_ROLE = keccak256("RECYCLER_ROLE");
    bytes32 public constant AI_VERIFIER_ROLE = keccak256("AI_VERIFIER_ROLE");
    bytes32 public constant OFFSET_REGISTRY_ROLE = keccak256("OFFSET_REGISTRY_ROLE");

    bytes32 public constant STAGE_TYPEHASH = keccak256(
        "StageAttestation(uint256 passportId,uint8 stage,bytes32 fieldsRoot,bytes32 evidenceHash,uint256 carbonG,uint256 energyWh,uint256 waterL,string facility,uint256 nonce,uint256 deadline)"
    );

    /// CIRC reward per gram of recovered material (18 decimals => 1 CIRC per kg).
    uint256 public constant CIRC_PER_GRAM = 1e15;

    enum Stage { Design, WaferFab, Assembly, Test, Logistics, EndOfLife }
    enum Verdict { Pending, Verified, Flagged, Rejected }
    enum Status { Active, Integrated, Recycled }

    struct Passport {
        string product;
        string processNode;
        string metadataURI;
        bytes32 designCommitment;
        uint64 units;
        uint64 unitsAllocated;
        uint64 unitsRecycled;
        uint64 createdAt;
        Status status;
        uint256 ownCarbonG;
        uint256 inheritedCarbonG;
        uint256 energyWh;
        uint256 waterL;
        uint256 offsetG;
    }

    struct StageRecord {
        Stage stage;
        address attester;
        uint64 timestamp;
        bytes32 fieldsRoot;
        bytes32 evidenceHash;
        uint256 carbonG;
        uint256 energyWh;
        uint256 waterL;
        string facility;
        Verdict verdict;
        uint16 aiScore;
        bytes32 aiReportHash;
    }

    struct Component {
        uint256 childId;
        uint64 units;
        uint256 carbonG;
    }

    struct StageAttestation {
        uint256 passportId;
        uint8 stage;
        bytes32 fieldsRoot;
        bytes32 evidenceHash;
        uint256 carbonG;
        uint256 energyWh;
        uint256 waterL;
        string facility;
        uint256 nonce;
        uint256 deadline;
    }

    CircularityToken public immutable circ;
    uint256 public nextId = 1;

    mapping(uint256 => Passport) private _passports;
    mapping(uint256 => StageRecord[]) private _stages;
    mapping(uint256 => Component[]) private _components;
    mapping(address => uint256) public nonces;
    /// AI verdict counts per attester, indexed by Verdict (Pending unused).
    mapping(address => uint32[4]) private _verdictCounts;

    event PassportCreated(uint256 indexed id, address indexed owner, string product, string processNode, uint64 units, bytes32 designCommitment);
    event StageRecorded(uint256 indexed id, uint256 indexed index, Stage stage, address indexed attester, uint256 carbonG, bytes32 fieldsRoot, bytes32 evidenceHash);
    event AIVerdict(uint256 indexed id, uint256 indexed index, Verdict verdict, uint16 score, bytes32 reportHash);
    event ComponentIntegrated(uint256 indexed parentId, uint256 indexed childId, uint64 units, uint256 carbonG);
    event OffsetApplied(uint256 indexed id, uint256 grams, uint256 indexed retirementId);
    event Recycled(uint256 indexed id, address indexed recycler, uint64 units, uint256 recoveredG, uint256 reward);

    error UnknownPassport(uint256 id);
    error NotAuthorizedAttester(address signer, Stage stage);
    error BadNonce(uint256 expected, uint256 got);
    error Expired();
    error StageOutOfOrder(Stage last, Stage attempted);
    error NotActive(uint256 id);
    error InvalidStage();
    error ComponentOverAllocated(uint256 childId, uint64 available, uint64 requested);
    error ComponentMustPredateParent();
    error OffsetExceedsFootprint(uint256 footprint, uint256 requested);
    error BadIndex();
    error RecycleExceedsUnits();

    constructor(CircularityToken circ_) ERC721("GreenSilicon Passport", "GSIL") EIP712("GreenSilicon", "1") {
        circ = circ_;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    // ------------------------------------------------------------------ minting

    function createPassport(
        address owner,
        string calldata product,
        string calldata processNode,
        uint64 units,
        bytes32 designCommitment,
        string calldata metadataURI
    ) external onlyRole(DESIGNER_ROLE) returns (uint256 id) {
        require(units > 0, "units=0");
        id = nextId++;
        Passport storage p = _passports[id];
        p.product = product;
        p.processNode = processNode;
        p.metadataURI = metadataURI;
        p.designCommitment = designCommitment;
        p.units = units;
        p.createdAt = uint64(block.timestamp);
        _safeMint(owner, id);
        emit PassportCreated(id, owner, product, processNode, units, designCommitment);
    }

    // ------------------------------------------------------------ stage records

    function roleForStage(Stage stage) public pure returns (bytes32) {
        if (stage == Stage.Design) return DESIGNER_ROLE;
        if (stage == Stage.WaferFab) return FAB_ROLE;
        if (stage == Stage.Assembly || stage == Stage.Test) return OSAT_ROLE;
        if (stage == Stage.Logistics) return LOGISTICS_ROLE;
        revert InvalidStage(); // EndOfLife goes through recycle()
    }

    function hashAttestation(StageAttestation calldata a) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(
            STAGE_TYPEHASH,
            a.passportId,
            a.stage,
            a.fieldsRoot,
            a.evidenceHash,
            a.carbonG,
            a.energyWh,
            a.waterL,
            keccak256(bytes(a.facility)),
            a.nonce,
            a.deadline
        )));
    }

    /**
     * @notice Anchor a stage record. With an empty signature the caller is the
     * attester; otherwise anyone may relay a record signed by the attester.
     */
    function recordStage(StageAttestation calldata a, bytes calldata signature) external returns (uint256 index) {
        _requireActive(a.passportId);
        if (a.stage > uint8(Stage.Logistics)) revert InvalidStage();
        Stage stage = Stage(a.stage);

        address attester;
        if (signature.length == 0) {
            attester = msg.sender;
        } else {
            if (block.timestamp > a.deadline) revert Expired();
            attester = ECDSA.recover(hashAttestation(a), signature);
            if (nonces[attester] != a.nonce) revert BadNonce(nonces[attester], a.nonce);
            nonces[attester]++;
        }
        if (!hasRole(roleForStage(stage), attester)) revert NotAuthorizedAttester(attester, stage);

        StageRecord[] storage recs = _stages[a.passportId];
        if (recs.length > 0 && stage < recs[recs.length - 1].stage) {
            revert StageOutOfOrder(recs[recs.length - 1].stage, stage);
        }

        recs.push(StageRecord({
            stage: stage,
            attester: attester,
            timestamp: uint64(block.timestamp),
            fieldsRoot: a.fieldsRoot,
            evidenceHash: a.evidenceHash,
            carbonG: a.carbonG,
            energyWh: a.energyWh,
            waterL: a.waterL,
            facility: a.facility,
            verdict: Verdict.Pending,
            aiScore: 0,
            aiReportHash: bytes32(0)
        }));

        Passport storage p = _passports[a.passportId];
        p.ownCarbonG += a.carbonG;
        p.energyWh += a.energyWh;
        p.waterL += a.waterL;

        index = recs.length - 1;
        emit StageRecorded(a.passportId, index, stage, attester, a.carbonG, a.fieldsRoot, a.evidenceHash);
    }

    /// @notice AI auditor oracle posts its verdict for a stage record.
    function attestAI(uint256 id, uint256 index, Verdict verdict, uint16 score, bytes32 reportHash)
        external
        onlyRole(AI_VERIFIER_ROLE)
    {
        if (index >= _stages[id].length) revert BadIndex();
        require(score <= 10000, "score>10000");
        StageRecord storage r = _stages[id][index];
        uint32[4] storage counts = _verdictCounts[r.attester];
        if (r.verdict != Verdict.Pending) counts[uint8(r.verdict)]--; // re-audit replaces the old verdict
        if (verdict != Verdict.Pending) counts[uint8(verdict)]++;
        r.verdict = verdict;
        r.aiScore = score;
        r.aiReportHash = reportHash;
        emit AIVerdict(id, index, verdict, score, reportHash);
    }

    // ---------------------------------------------------------- composition

    /**
     * @notice Integrate `units` of a component lot (chiplet, HBM stack, substrate)
     * into an assembled lot. Carbon is allocated pro-rata and snapshotted, and
     * the component can never be allocated beyond its unit count.
     */
    function integrateComponent(uint256 parentId, uint256 childId, uint64 units) external onlyRole(OSAT_ROLE) {
        _requireActive(parentId);
        _requireActive(childId);
        if (childId >= parentId) revert ComponentMustPredateParent();
        Passport storage c = _passports[childId];
        uint64 available = c.units - c.unitsAllocated;
        if (units == 0 || units > available) revert ComponentOverAllocated(childId, available, units);

        uint256 allocated = (totalCarbonG(childId) * units) / c.units;
        c.unitsAllocated += units;
        if (c.unitsAllocated == c.units) c.status = Status.Integrated;

        _passports[parentId].inheritedCarbonG += allocated;
        _components[parentId].push(Component({childId: childId, units: units, carbonG: allocated}));
        emit ComponentIntegrated(parentId, childId, units, allocated);
    }

    // -------------------------------------------------------------- offsets

    function recordOffset(uint256 id, uint256 grams, uint256 retirementId) external onlyRole(OFFSET_REGISTRY_ROLE) {
        _requireExists(id);
        Passport storage p = _passports[id];
        uint256 footprint = totalCarbonG(id);
        if (p.offsetG + grams > footprint) revert OffsetExceedsFootprint(footprint, p.offsetG + grams);
        p.offsetG += grams;
        emit OffsetApplied(id, grams, retirementId);
    }

    // ---------------------------------------------------------- end of life

    function recycle(
        uint256 id,
        uint64 units,
        uint256 recoveredG,
        uint256 processCarbonG,
        bytes32 fieldsRoot,
        bytes32 evidenceHash,
        string calldata facility
    ) external onlyRole(RECYCLER_ROLE) returns (uint256 reward) {
        _requireExists(id);
        Passport storage p = _passports[id];
        if (units == 0 || p.unitsRecycled + units > p.units) revert RecycleExceedsUnits();
        p.unitsRecycled += units;
        if (p.unitsRecycled == p.units) p.status = Status.Recycled;
        p.ownCarbonG += processCarbonG;

        _stages[id].push(StageRecord({
            stage: Stage.EndOfLife,
            attester: msg.sender,
            timestamp: uint64(block.timestamp),
            fieldsRoot: fieldsRoot,
            evidenceHash: evidenceHash,
            carbonG: processCarbonG,
            energyWh: 0,
            waterL: 0,
            facility: facility,
            verdict: Verdict.Pending,
            aiScore: 0,
            aiReportHash: bytes32(0)
        }));
        uint256 index = _stages[id].length - 1;
        emit StageRecorded(id, index, Stage.EndOfLife, msg.sender, processCarbonG, fieldsRoot, evidenceHash);

        reward = recoveredG * CIRC_PER_GRAM;
        emit Recycled(id, msg.sender, units, recoveredG, reward);
        circ.mint(msg.sender, reward); // external call last (checks-effects-interactions)
    }

    // --------------------------------------------------------------- views

    function totalCarbonG(uint256 id) public view returns (uint256) {
        Passport storage p = _passports[id];
        return p.ownCarbonG + p.inheritedCarbonG;
    }

    function carbonPerUnitG(uint256 id) external view returns (uint256) {
        return totalCarbonG(id) / _passports[id].units;
    }

    /// @notice Share (basis points) of this lot's own stage carbon whose record the AI auditor verified.
    function verifiedShareBps(uint256 id) external view returns (uint256) {
        StageRecord[] storage recs = _stages[id];
        uint256 total = 0;
        uint256 verified = 0;
        for (uint256 i; i < recs.length; i++) {
            total += recs[i].carbonG;
            if (recs[i].verdict == Verdict.Verified) verified += recs[i].carbonG;
        }
        return total == 0 ? 0 : (verified * 10000) / total;
    }

    /**
     * @notice Supplier reputation from AI verdict history. Bayesian score in
     * basis points with a prior of two neutral (50%) records, so a new
     * supplier starts at 50% and one good record cannot buy a perfect score.
     * Verified counts 100%, Flagged 40%, Rejected 0%.
     */
    function supplierTrust(address attester)
        external
        view
        returns (uint32 verified, uint32 flagged, uint32 rejected, uint256 scoreBps)
    {
        uint32[4] storage c = _verdictCounts[attester];
        verified = c[uint8(Verdict.Verified)];
        flagged = c[uint8(Verdict.Flagged)];
        rejected = c[uint8(Verdict.Rejected)];
        uint256 n = uint256(verified) + flagged + rejected;
        scoreBps = (uint256(verified) * 10000 + uint256(flagged) * 4000 + 2 * 5000) / (n + 2);
    }

    function getPassport(uint256 id) external view returns (Passport memory) {
        _requireExists(id);
        return _passports[id];
    }

    function getStages(uint256 id) external view returns (StageRecord[] memory) {
        return _stages[id];
    }

    function getComponents(uint256 id) external view returns (Component[] memory) {
        return _components[id];
    }

    /**
     * @notice Selective disclosure: prove one salted field of a stage record
     * belongs to its committed Merkle root without revealing the rest.
     */
    function verifyField(
        uint256 id,
        uint256 index,
        string calldata key,
        string calldata value,
        bytes32 salt,
        bytes32[] calldata proof
    ) external view returns (bool) {
        if (index >= _stages[id].length) revert BadIndex();
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(key, value, salt))));
        return MerkleProof.verifyCalldata(proof, _stages[id][index].fieldsRoot, leaf);
    }

    function tokenURI(uint256 id) public view override returns (string memory) {
        _requireExists(id);
        return _passports[id].metadataURI;
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    // ------------------------------------------------------------ internals

    function _requireExists(uint256 id) internal view {
        if (_ownerOf(id) == address(0)) revert UnknownPassport(id);
    }

    function _requireActive(uint256 id) internal view {
        _requireExists(id);
        if (_passports[id].status != Status.Active) revert NotActive(id);
    }
}
