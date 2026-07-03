pragma circom 2.0.0;

// Entry point for the 2x3 circuit shape (2 nullifiers, 3 commitments)
include "../operations/Transact.circom";

component main {public [merkleRoot, boundParamsHash, nullifiers, commitmentsOut]} = Transact(2, 3);
