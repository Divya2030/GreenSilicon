// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @title TelemetryRegistry
 * @notice Digital MRV for fabs: tamper-evident IoT telemetry anchoring.
 *
 * Each meter (sub-meter on a tool line, abatement-unit gas analyser, water
 * meter) holds its own signing key, ideally in a secure element. The meter
 * signs batches of readings (EIP-712); anyone may relay them. Only a Merkle
 * root plus aggregates go on-chain, and any single reading can be proven
 * later. Batches must be contiguous in time, so a facility cannot backfill or
 * drop an inconvenient period (for example, an abatement outage).
 */
contract TelemetryRegistry is AccessControl, EIP712 {
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 public constant BATCH_TYPEHASH = keccak256(
        "TelemetryBatch(address device,uint64 fromTs,uint64 toTs,uint32 count,bytes32 root,uint256 total,uint32 alerts,uint256 nonce)"
    );

    /// Power: Wh per reading. Abatement: destruction efficiency in bps. Water: litres.
    enum Kind { Power, Abatement, Water }

    struct Device {
        address operator;
        Kind kind;
        bool active;
        uint64 registeredAt;
        string facility;
    }

    struct Batch {
        uint64 fromTs;
        uint64 toTs;
        uint32 count;
        uint32 alerts;
        bytes32 root;
        uint256 total;
        uint64 anchoredAt;
    }

    struct BatchMsg {
        address device;
        uint64 fromTs;
        uint64 toTs;
        uint32 count;
        bytes32 root;
        uint256 total;
        uint32 alerts;
        uint256 nonce;
    }

    mapping(address => Device) private _devices;
    mapping(address => Batch[]) private _batches;
    mapping(address => uint256) public nonces;
    address[] private _deviceList;

    event DeviceRegistered(address indexed device, address indexed operator, Kind kind, string facility);
    event DeviceStatus(address indexed device, bool active);
    event BatchAnchored(address indexed device, uint256 indexed index, uint64 fromTs, uint64 toTs, uint32 count, uint256 total, uint32 alerts, bytes32 root);

    error UnknownDevice(address device);
    error DeviceExists(address device);
    error NotOperator();
    error Inactive();
    error BadSignature();
    error BadNonce();
    error NonContiguous(uint64 expectedFrom, uint64 got);
    error BadRange();

    constructor() EIP712("GreenSilicon Telemetry", "1") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function registerDevice(address device, Kind kind, string calldata facility) external onlyRole(OPERATOR_ROLE) {
        if (_devices[device].operator != address(0)) revert DeviceExists(device);
        _devices[device] = Device({operator: msg.sender, kind: kind, active: true, registeredAt: uint64(block.timestamp), facility: facility});
        _deviceList.push(device);
        emit DeviceRegistered(device, msg.sender, kind, facility);
    }

    function setActive(address device, bool active) external {
        Device storage d = _devices[device];
        if (d.operator == address(0)) revert UnknownDevice(device);
        if (d.operator != msg.sender && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotOperator();
        d.active = active;
        emit DeviceStatus(device, active);
    }

    function hashBatch(BatchMsg calldata b) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(BATCH_TYPEHASH, b.device, b.fromTs, b.toTs, b.count, b.root, b.total, b.alerts, b.nonce)));
    }

    /// @notice Anchor a meter-signed batch. Relayable by anyone.
    function anchorBatch(BatchMsg calldata b, bytes calldata signature) external returns (uint256 index) {
        Device storage d = _devices[b.device];
        if (d.operator == address(0)) revert UnknownDevice(b.device);
        if (!d.active) revert Inactive();
        if (ECDSA.recover(hashBatch(b), signature) != b.device) revert BadSignature();
        if (b.nonce != nonces[b.device]) revert BadNonce();
        if (b.toTs < b.fromTs || b.count == 0) revert BadRange();
        Batch[] storage list = _batches[b.device];
        if (list.length > 0 && b.fromTs != list[list.length - 1].toTs) revert NonContiguous(list[list.length - 1].toTs, b.fromTs);
        nonces[b.device]++;
        list.push(Batch({fromTs: b.fromTs, toTs: b.toTs, count: b.count, alerts: b.alerts, root: b.root, total: b.total, anchoredAt: uint64(block.timestamp)}));
        index = list.length - 1;
        emit BatchAnchored(b.device, index, b.fromTs, b.toTs, b.count, b.total, b.alerts, b.root);
    }

    /// @notice Prove a single reading (timestamp, value) belongs to an anchored batch.
    function verifyReading(address device, uint256 index, uint64 ts, uint256 value, bytes32[] calldata proof) external view returns (bool) {
        Batch storage b = _batches[device][index];
        if (ts < b.fromTs || ts > b.toTs) return false;
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(ts, value))));
        return MerkleProof.verifyCalldata(proof, b.root, leaf);
    }

    function getDevice(address device) external view returns (Device memory) {
        return _devices[device];
    }

    function getDevices() external view returns (address[] memory) {
        return _deviceList;
    }

    function getBatches(address device) external view returns (Batch[] memory) {
        return _batches[device];
    }

    function batchCount(address device) external view returns (uint256) {
        return _batches[device].length;
    }
}
