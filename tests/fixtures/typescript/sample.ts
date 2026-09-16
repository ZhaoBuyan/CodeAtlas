import { Base } from './base';

/** 形状契约（接口级说明）。 */
export interface Shape {
  area(): number;
}

/** 图形基类：测试继承抽取。 */
export abstract class Figure extends Base {
  /** 名字。 */
  name = 'figure';

  abstract area(): number;

  scale(k: number) {
    return k > 0 ? k : 1;
  }
}

export class Circle extends Figure implements Shape {
  radius = 1;

  area() {
    return 3.14 * this.radius ** 2;
  }
}

export type Id = string | number;

export enum Kind {
  A = 'a',
  B = 'b',
}

export function helper(a: number) {
  if (a > 0 && a < 10) return a;
  return -a;
}
