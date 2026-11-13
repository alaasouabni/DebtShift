// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.19;

// These imports intentionally make the exact vendored upstream contracts part
// of this isolated Foundry build. DebtShift never modifies their source.
import { Morpho } from "morpho-blue/src/Morpho.sol";
import {
    AdaptiveCurveIrm
} from "morpho-blue/src/periphery/adaptive-curve-irm/AdaptiveCurveIrm.sol";

contract CanonicalMorphoArtifacts { }
