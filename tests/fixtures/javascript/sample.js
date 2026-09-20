import { Base } from './base';

/** 小部件：测试 JS 的类 / 继承 / 函数抽取。 */
export class Widget extends Base {
  constructor() {
    super();
    this.state = {};
  }

  render() {
    return 1 > 0 && Boolean(this.state) ? 'a' : 'b';
  }
}

export function make(x) {
  // 同一个类型引用两次 → 这条边的权重是 2
  const w = new Widget(x);
  return w instanceof Widget ? 1 : 0;
}
