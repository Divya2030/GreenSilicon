// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {GreenSiliconPassport} from "./GreenSiliconPassport.sol";

/**
 * @title CarbonCreditRegistry
 * @notice Tokenized carbon credits (1 token = 1 kg CO2e) that can only be
 * claimed against a chip passport by retiring (burning) them.
 *
 * Double-counting controls:
 *  - double issuance: an external registry serial can be tokenized only once;
 *  - double use: retiring burns the tokens, so they can never be resold;
 *  - double claiming: GreenSiliconPassport refuses offsets that exceed the footprint.
 */
contract CarbonCreditRegistry is ERC1155, AccessControl {
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");

    struct CreditBatch {
        string projectName;
        string methodology;
        string registrySerial;
        uint16 vintage;
        uint256 issuedKg;
        uint256 retiredKg;
        bytes32 evidenceHash;
        address issuer;
    }

    struct Retirement {
        uint256 batchId;
        uint256 passportId;
        uint256 amountKg;
        address retiree;
        string beneficiary;
        uint64 timestamp;
    }

    GreenSiliconPassport public immutable passport;
    uint256 public nextBatchId = 1;
    CreditBatch[] private _batches;
    Retirement[] private _retirements;
    mapping(bytes32 => bool) public serialUsed;

    event BatchIssued(uint256 indexed batchId, address indexed to, uint256 amountKg, string registrySerial, uint16 vintage);
    event CreditsRetired(uint256 indexed retirementId, uint256 indexed batchId, uint256 indexed passportId, uint256 amountKg, address retiree, string beneficiary);

    error SerialAlreadyTokenized(string serial);

    constructor(GreenSiliconPassport passport_) ERC1155("") {
        passport = passport_;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _batches.push(); // batch ids start at 1
    }

    function issueBatch(
        address to,
        uint256 amountKg,
        string calldata projectName,
        string calldata methodology,
        string calldata registrySerial,
        uint16 vintage,
        bytes32 evidenceHash
    ) external onlyRole(ISSUER_ROLE) returns (uint256 batchId) {
        bytes32 key = keccak256(bytes(registrySerial));
        if (serialUsed[key]) revert SerialAlreadyTokenized(registrySerial);
        serialUsed[key] = true;

        batchId = nextBatchId++;
        _batches.push(CreditBatch({
            projectName: projectName,
            methodology: methodology,
            registrySerial: registrySerial,
            vintage: vintage,
            issuedKg: amountKg,
            retiredKg: 0,
            evidenceHash: evidenceHash,
            issuer: msg.sender
        }));
        _mint(to, batchId, amountKg, "");
        emit BatchIssued(batchId, to, amountKg, registrySerial, vintage);
    }

    /// @notice Burn credits and permanently attribute them to a chip passport.
    function retire(uint256 batchId, uint256 amountKg, uint256 passportId, string calldata beneficiary)
        external
        returns (uint256 retirementId)
    {
        require(amountKg > 0, "amount=0");
        _burn(msg.sender, batchId, amountKg);
        _batches[batchId].retiredKg += amountKg;
        retirementId = _retirements.length;
        _retirements.push(Retirement({
            batchId: batchId,
            passportId: passportId,
            amountKg: amountKg,
            retiree: msg.sender,
            beneficiary: beneficiary,
            timestamp: uint64(block.timestamp)
        }));
        passport.recordOffset(passportId, amountKg * 1000, retirementId);
        emit CreditsRetired(retirementId, batchId, passportId, amountKg, msg.sender, beneficiary);
    }

    function getBatch(uint256 batchId) external view returns (CreditBatch memory) {
        require(batchId > 0 && batchId < _batches.length, "unknown batch");
        return _batches[batchId];
    }

    function batchCount() external view returns (uint256) {
        return _batches.length - 1;
    }

    function getRetirements() external view returns (Retirement[] memory) {
        return _retirements;
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC1155, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
