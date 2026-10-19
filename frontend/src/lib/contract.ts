// Minimal, embedded ABI so the verifier does not depend on our server.
export const PASSPORT_ABI = [
  "function nextId() view returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
  "function totalCarbonG(uint256) view returns (uint256)",
  "function verifiedShareBps(uint256) view returns (uint256)",
  "function getPassport(uint256) view returns (tuple(string product,string processNode,string metadataURI,bytes32 designCommitment,uint64 units,uint64 unitsAllocated,uint64 unitsRecycled,uint64 createdAt,uint8 status,uint256 ownCarbonG,uint256 inheritedCarbonG,uint256 energyWh,uint256 waterL,uint256 offsetG))",
  "function getStages(uint256) view returns (tuple(uint8 stage,address attester,uint64 timestamp,bytes32 fieldsRoot,bytes32 evidenceHash,uint256 carbonG,uint256 energyWh,uint256 waterL,string facility,uint8 verdict,uint16 aiScore,bytes32 aiReportHash)[])",
  "function getComponents(uint256) view returns (tuple(uint256 childId,uint64 units,uint256 carbonG)[])",
  "function verifyField(uint256 id,uint256 index,string key,string value,bytes32 salt,bytes32[] proof) view returns (bool)",
  "function hasRole(bytes32 role,address account) view returns (bool)",
];

export const STAGES = ["Design", "WaferFab", "Assembly", "Test", "Logistics", "EndOfLife"];
export const VERDICTS = ["Pending", "Verified", "Flagged", "Rejected"] as const;
export const STATUSES = ["Active", "Integrated", "Recycled"];
