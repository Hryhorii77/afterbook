// New Basis Tilt enrollments are paused (owner, 2026-11-19). Enrolling asks the wallet to sign a bare 32-byte hash
// that Glider returns through our server, and Kernel accounts accept an EIP-191 signature over a hash as
// authorisation, so a compromised server could hand over a hash that does something else (enable another module, or
// a user operation on an account the wallet already owns). Until the browser recomputes that hash from the enable
// data it should mean, no new enrollment is offered and both enrollment routes refuse. Enrolled wallets keep
// deposit, start and withdraw.
export const ENROLLMENT_PAUSED = true;

export const ENROLLMENT_PAUSED_MESSAGE =
  'New enrollments are paused while we add a check that the message you sign can only enroll you. Already enrolled? Your account, deposits and withdrawals work as before.';
