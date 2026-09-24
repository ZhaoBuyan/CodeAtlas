import { Wheel } from './wheel';

/** 视图：引用**另一个文件**（.ts）里的类型 —— 这条边必须接上。
 *  为什么单独造这个样例：这里是 `.tsx` → `.ts` 的跨文件依赖，而引擎一度按"语言 id 相等"
 *  过滤跨语言解析，把这一整类真依赖切掉了（实测一个真项目丢 3,086 条）。见 src/languages.mjs
 *  的 `family` 与 src/scan.mjs 的 sameFamily()。 */
export function View(props: { wheel: Wheel }) {
  return null;
}
