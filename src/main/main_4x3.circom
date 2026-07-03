pragma circom 2.0.0;

// Entry point for the 4x3 circuit shape (4 nullifiers, 3 commitments)
include "../operations/Transact.circom";

component main {public [merkleRoot, boundParamsHash, nullifiers, commitmentsOut]} = Transact(4, 3);
