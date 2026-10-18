import { CoworkNativeReceiptKey } from "../../src/cowork/native/receipt-mac";
/** A synthetic receipt key for tests that need one in hand. */
export const CoworkReceiptKeyForTest = (): CoworkNativeReceiptKey => CoworkNativeReceiptKey.fromBytes(Uint8Array.from({ length: 32 }, (_, i) => 0x30 + i));
