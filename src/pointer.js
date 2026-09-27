// 指针（鼠标 / 手指）在水中的射线，鱼群、悬浮颗粒、划水气泡共用
import { Vector3 } from 'three/webgpu';
import { uniform } from 'three/tsl';

export const pointer = {
	origin: uniform( new Vector3() ),
	dir: uniform( new Vector3( 0, 0, - 1 ) ),
	active: uniform( 0 ),
};
