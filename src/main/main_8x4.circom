pragma circom 2.0.0;

// Entry point for the 8x4 circuit shape (8 nullifiers, 4 commitments)
include "../operations/Transact.circom";

component main {public [merkleRoot, boundParamsHash, nullifiers, commitmentsOut]} = Transact(8, 4);
