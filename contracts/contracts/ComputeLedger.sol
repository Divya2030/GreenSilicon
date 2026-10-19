// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {GreenSiliconPassport} from "./GreenSiliconPassport.sol";

/**
 * @title ComputeLedger
 * @notice Use phase of a chip passport: AI accelerators running in data centers.
 *
 * Data-center operators register facilities (PUE, on-site WUE, off-site
 * electricity water intensity), deploy accelerator lots that have a
 * GreenSilicon passport, and certify AI jobs. Each job mints a Green Compute
 * Certificate (ERC-721) to the customer with:
 *   - operational carbon (location-based, reported by the operator),
 *   - on-site cooling water (metered) and off-site water for electricity,
 *   - embodied carbon amortised from the chip passport, computed here on-chain.
 *
 * Embodied carbon can never be over-allocated: a deployment's certified
 * accelerator-hours are capped at units x rated lifetime, and a passport's
 * units can only be deployed once.
 */
contract ComputeLedger is ERC721, AccessControl {
    bytes32 public constant DATACENTER_ROLE = keccak256("DATACENTER_ROLE");

    struct DataCenter {
        string name;
        string region;
        uint16 pueMilli;      // 1180 = PUE 1.18
        uint32 wueMl;         // on-site water, mL per kWh of IT energy
        uint32 ewifMl;        // off-site water, mL per kWh of facility electricity
        uint8 waterStress;    // 0 low .. 4 extremely high (WRI Aqueduct category)
        address operator;
    }

    struct Deployment {
        uint256 passportId;
        uint32 dcId;
        uint64 units;
        uint64 lifetimeHours;     // rated service hours per accelerator
        uint64 deployedAt;
        uint256 embodiedPerUnitG; // snapshot of the passport's cradle-to-gate carbon per unit
        uint256 centiHoursUsed;   // accelerator-hours x 100 already certified
    }

    struct CertInput {
        uint256 deploymentId;
        uint64 startTs;
        uint64 endTs;
        uint64 centiHours;        // accelerator-hours x 100
        uint256 itEnergyWh;
        uint256 operationalG;     // location-based CO2e for the facility energy
        uint256 waterOnsiteL;     // metered cooling water
        uint256 baselineG;        // operational CO2e had the job run unscheduled (for savings)
        bytes32 jobHash;          // hash of the off-site job manifest
        bytes32 workHash;         // fingerprint of the work: model + dataset version + parameters (0 = none)
        uint256 parentCertPlusOne; // incremental run continuing from this certificate (+1; 0 = from scratch)
    }

    struct Certificate {
        uint256 deploymentId;
        uint64 startTs;
        uint64 endTs;
        uint64 centiHours;
        uint256 itEnergyWh;
        uint256 facilityEnergyWh;
        uint256 operationalG;
        uint256 embodiedG;
        uint256 waterOnsiteL;
        uint256 waterOffsiteL;
        uint256 baselineG;
        bytes32 jobHash;
        bytes32 workHash;
        uint256 parentCertPlusOne;
        uint256 avoidedG;         // CO2e avoided by reuse or incremental computation
        bool reused;              // true = result served from an earlier identical computation
    }

    struct Lifecycle {
        uint256 unitsDeployed;
        uint256 centiHours;
        uint256 embodiedAllocatedG;
        uint256 operationalG;
        uint256 waterL;
        uint256 energyWh;
        uint256 certificates;
        uint256 avoidedG;
    }

    GreenSiliconPassport public immutable passport;
    DataCenter[] private _dcs;
    Deployment[] private _deployments;
    Certificate[] private _certs;
    mapping(uint256 => uint256) public unitsDeployed; // passportId => units
    mapping(uint256 => Lifecycle) private _lifecycle;  // passportId => use-phase totals
    /// First certificate (+1) that computed a given work fingerprint: the reusable result.
    mapping(bytes32 => uint256) public workCertPlusOne;
    uint256 public totalAvoidedG;

    event DataCenterRegistered(uint256 indexed dcId, address indexed operator, string name, string region);
    event Deployed(uint256 indexed deploymentId, uint256 indexed passportId, uint256 indexed dcId, uint64 units, uint256 embodiedPerUnitG);
    event ComputeReused(uint256 indexed certId, uint256 indexed sourceCertId, address indexed customer, bytes32 workHash, uint256 avoidedG);
    event ComputeCertified(uint256 indexed certId, uint256 indexed deploymentId, address indexed customer, uint64 centiHours, uint256 operationalG, uint256 embodiedG, uint256 waterL);

    error NotOperator();
    error UnknownDataCenter();
    error UnknownDeployment();
    error DeployExceedsUnits(uint256 available, uint256 requested);
    error LifetimeExceeded(uint256 remainingCentiHours, uint256 requested);
    error BadInput();
    error NoReusableResult(bytes32 workHash);

    constructor(GreenSiliconPassport passport_) ERC721("GreenSilicon Compute Certificate", "GSCC") {
        passport = passport_;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function registerDataCenter(string calldata name, string calldata region, uint16 pueMilli, uint32 wueMl, uint32 ewifMl, uint8 waterStress)
        external
        onlyRole(DATACENTER_ROLE)
        returns (uint256 dcId)
    {
        if (pueMilli < 1000 || waterStress > 4) revert BadInput();
        dcId = _dcs.length;
        _dcs.push(DataCenter(name, region, pueMilli, wueMl, ewifMl, waterStress, msg.sender));
        emit DataCenterRegistered(dcId, msg.sender, name, region);
    }

    /// @notice Deploy units of an accelerator lot into a data center. Each unit can be deployed once.
    function deploy(uint256 passportId, uint32 dcId, uint64 units, uint64 lifetimeHours) external returns (uint256 deploymentId) {
        if (dcId >= _dcs.length) revert UnknownDataCenter();
        if (_dcs[dcId].operator != msg.sender) revert NotOperator();
        if (units == 0 || lifetimeHours == 0) revert BadInput();
        GreenSiliconPassport.Passport memory p = passport.getPassport(passportId);
        uint256 available = p.units - unitsDeployed[passportId];
        if (units > available) revert DeployExceedsUnits(available, units);
        unitsDeployed[passportId] += units;
        uint256 perUnit = passport.carbonPerUnitG(passportId);
        deploymentId = _deployments.length;
        _deployments.push(Deployment(passportId, dcId, units, lifetimeHours, uint64(block.timestamp), perUnit, 0));
        _lifecycle[passportId].unitsDeployed += units;
        emit Deployed(deploymentId, passportId, dcId, units, perUnit);
    }

    /// @notice Certify an AI job and mint its Green Compute Certificate to the customer.
    function certify(CertInput calldata c, address customer) external returns (uint256 certId) {
        if (c.deploymentId >= _deployments.length) revert UnknownDeployment();
        Deployment storage d = _deployments[c.deploymentId];
        DataCenter storage dc = _dcs[d.dcId];
        if (dc.operator != msg.sender) revert NotOperator();
        if (c.centiHours == 0 || c.endTs < c.startTs) revert BadInput();
        uint256 capacity = uint256(d.units) * d.lifetimeHours * 100;
        if (d.centiHoursUsed + c.centiHours > capacity) revert LifetimeExceeded(capacity - d.centiHoursUsed, c.centiHours);
        d.centiHoursUsed += c.centiHours;

        uint256 facilityWh = (c.itEnergyWh * dc.pueMilli) / 1000;
        uint256 offsiteL = (c.itEnergyWh * dc.pueMilli * dc.ewifMl) / 1e9; // Wh x PUE x mL/kWh, single rounding
        uint256 embodied = (d.embodiedPerUnitG * c.centiHours) / (uint256(d.lifetimeHours) * 100);

        // Incremental run: credit the energy not spent recomputing from scratch,
        // measured against the parent run's certified footprint.
        uint256 avoided = 0;
        if (c.parentCertPlusOne != 0) {
            if (c.parentCertPlusOne > _certs.length) revert BadInput();
            uint256 parentOp = _certs[c.parentCertPlusOne - 1].operationalG;
            if (parentOp > c.operationalG) avoided = parentOp - c.operationalG;
        }

        certId = _certs.length;
        _certs.push(Certificate(c.deploymentId, c.startTs, c.endTs, c.centiHours, c.itEnergyWh, facilityWh, c.operationalG, embodied,
            c.waterOnsiteL, offsiteL, c.baselineG, c.jobHash, c.workHash, c.parentCertPlusOne, avoided, false));
        if (c.workHash != bytes32(0) && workCertPlusOne[c.workHash] == 0) workCertPlusOne[c.workHash] = certId + 1;
        totalAvoidedG += avoided;

        Lifecycle storage l = _lifecycle[d.passportId];
        l.avoidedG += avoided;
        l.centiHours += c.centiHours;
        l.embodiedAllocatedG += embodied;
        l.operationalG += c.operationalG;
        l.waterL += c.waterOnsiteL + offsiteL;
        l.energyWh += facilityWh;
        l.certificates += 1;

        _safeMint(customer, certId);
        emit ComputeCertified(certId, c.deploymentId, customer, c.centiHours, c.operationalG, embodied, c.waterOnsiteL + offsiteL);
    }

    /**
     * @notice Serve an identical computation from its stored result instead of
     * running it again. Mints a reuse certificate with zero new energy; the
     * avoided footprint is taken from the original certificate, so it cannot
     * be inflated by the operator.
     */
    function certifyReuse(bytes32 workHash, address customer) external onlyRole(DATACENTER_ROLE) returns (uint256 certId) {
        uint256 srcPlusOne = workCertPlusOne[workHash];
        if (workHash == bytes32(0) || srcPlusOne == 0) revert NoReusableResult(workHash);
        Certificate storage src = _certs[srcPlusOne - 1];
        uint256 avoided = src.operationalG + src.embodiedG;
        certId = _certs.length;
        _certs.push(Certificate(src.deploymentId, uint64(block.timestamp), uint64(block.timestamp), 0, 0, 0, 0, 0, 0, 0,
            src.operationalG, src.jobHash, workHash, srcPlusOne, avoided, true));
        totalAvoidedG += avoided;
        Lifecycle storage l = _lifecycle[_deployments[src.deploymentId].passportId];
        l.certificates += 1;
        l.avoidedG += avoided;
        _safeMint(customer, certId);
        emit ComputeReused(certId, srcPlusOne - 1, customer, workHash, avoided);
    }

    // ------------------------------------------------------------------ views

    function dataCenterCount() external view returns (uint256) {
        return _dcs.length;
    }

    function getDataCenter(uint256 id) external view returns (DataCenter memory) {
        return _dcs[id];
    }

    function deploymentCount() external view returns (uint256) {
        return _deployments.length;
    }

    function getDeployment(uint256 id) external view returns (Deployment memory) {
        return _deployments[id];
    }

    function certificateCount() external view returns (uint256) {
        return _certs.length;
    }

    function getCertificate(uint256 id) external view returns (Certificate memory) {
        return _certs[id];
    }

    function lifecycle(uint256 passportId) external view returns (Lifecycle memory) {
        return _lifecycle[passportId];
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
