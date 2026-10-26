import { Signal } from './defs';
export class CatchOnly {
    run() { try {} catch (Signal) { Signal(); } }
}
export class Outside {
    run() { Signal(); try {} catch (Signal) { Signal(); } Signal(); }
}
export class TypePosition {
    run() { try {} catch (Signal) { let value: Signal; Signal(); } }
}

