"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LedgerPool = void 0;
const scrypt_ts_1 = require("scrypt-ts");
class LedgerPool extends scrypt_ts_1.SmartContract {
    constructor(sold, ledger, k, supply) {
        super(...arguments);
        this.sold = sold;
        this.ledger = ledger;
        this.k = k;
        this.supply = supply;
    }
    buy(owner, isNew, oldBal, delta, newReserve) {
        (0, scrypt_ts_1.assert)(delta > 0n, 'delta must be positive');
        (0, scrypt_ts_1.assert)(this.sold + delta <= this.supply, 'exceeds supply');
        const cost = (this.k * delta * (2n * this.sold + delta + 1n)) / 2n;
        (0, scrypt_ts_1.assert)(newReserve >= this.ctx.utxo.value + cost, 'underpaid');
        // credit the ledger. A first-time buyer has no entry: prove NON-membership so
        // `oldBal` can't be spoofed to overwrite/reset an existing balance (which would
        // break the sold == sum(balances) invariant). An existing buyer proves their
        // current balance, then we increment it.
        if (isNew) {
            (0, scrypt_ts_1.assert)(!this.ledger.has(owner), 'holder already exists');
            this.ledger.set(owner, delta);
        }
        else {
            (0, scrypt_ts_1.assert)(this.ledger.canGet(owner, oldBal), 'ledger proof (buy)');
            this.ledger.set(owner, oldBal + delta);
        }
        this.sold += delta;
        const out = this.buildStateOutput(newReserve);
        (0, scrypt_ts_1.assert)(this.ctx.hashOutputs === (0, scrypt_ts_1.hash256)(out), 're-lock successor pool');
    }
    sell(owner, ownerPub, ownerSig, oldBal, amount, payoutScript) {
        // the holder authorises the sell (this IS their claim to the balance)
        (0, scrypt_ts_1.assert)((0, scrypt_ts_1.hash160)(ownerPub) === owner, 'pubkey matches owner');
        (0, scrypt_ts_1.assert)(this.checkSig(ownerSig, ownerPub), 'owner signature');
        (0, scrypt_ts_1.assert)(amount > 0n, 'amount must be positive');
        (0, scrypt_ts_1.assert)(oldBal >= amount, 'insufficient balance');
        (0, scrypt_ts_1.assert)(this.ledger.canGet(owner, oldBal), 'ledger proof (sell)');
        // refund along the curve, rounded against the seller (pool keeps more)
        const newSold = this.sold - amount;
        const refund = (this.k * amount * (2n * newSold + amount + 1n)) / 2n;
        this.ledger.set(owner, oldBal - amount);
        this.sold = newSold;
        const reserveAfter = this.ctx.utxo.value - refund;
        const poolOut = this.buildStateOutput(reserveAfter);
        // pay the refund to the seller's payout script
        const payoutOut = scrypt_ts_1.Utils.buildOutput(payoutScript, refund);
        (0, scrypt_ts_1.assert)(this.ctx.hashOutputs === (0, scrypt_ts_1.hash256)(poolOut + payoutOut), 're-lock + payout');
    }
}
exports.LedgerPool = LedgerPool;
__decorate([
    (0, scrypt_ts_1.prop)(true),
    __metadata("design:type", BigInt)
], LedgerPool.prototype, "sold", void 0);
__decorate([
    (0, scrypt_ts_1.prop)(true),
    __metadata("design:type", Object)
], LedgerPool.prototype, "ledger", void 0);
__decorate([
    (0, scrypt_ts_1.prop)(),
    __metadata("design:type", BigInt)
], LedgerPool.prototype, "k", void 0);
__decorate([
    (0, scrypt_ts_1.prop)(),
    __metadata("design:type", BigInt)
], LedgerPool.prototype, "supply", void 0);
__decorate([
    (0, scrypt_ts_1.method)(scrypt_ts_1.SigHash.ANYONECANPAY_SINGLE),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Boolean, BigInt, BigInt, BigInt]),
    __metadata("design:returntype", void 0)
], LedgerPool.prototype, "buy", null);
__decorate([
    (0, scrypt_ts_1.method)(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, String, BigInt, BigInt, String]),
    __metadata("design:returntype", void 0)
], LedgerPool.prototype, "sell", null);
