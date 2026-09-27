// 编排：鱼群形态时间线 + 电影化镜头
import * as THREE from 'three/webgpu';
import { SURFACE_Y, FLOOR_Y, SUN_DIR } from './ocean.js';

// 形态按顺序轮换，每次切换在数秒内平滑过渡
const FORMATIONS = [
	{ name: 'ball', duration: 28 },
	{ name: 'tornado', duration: 24 },
	{ name: 'ball', duration: 16 },
	{ name: 'ring', duration: 24 },
	{ name: 'split', duration: 20 },
];

export function createFormationDirector( u ) {

	let index = 0;
	let timeInForm = 0;
	const weights = { ball: 1, tornado: 0, ring: 0, split: 0 };

	return function update( dt, t ) {

		timeInForm += dt;
		if ( timeInForm > FORMATIONS[ index ].duration ) {

			timeInForm = 0;
			index = ( index + 1 ) % FORMATIONS.length;

		}

		const current = FORMATIONS[ index ].name;
		const k = 1 - Math.exp( - dt * 0.35 );
		for ( const name in weights ) weights[ name ] += ( ( name === current ? 1 : 0 ) - weights[ name ] ) * k;

		u.wBall.value = weights.ball;
		u.wTornado.value = weights.tornado;
		u.wRing.value = weights.ring;
		u.wSplit.value = weights.split;

		// 两群的分布方向缓慢旋转
		const a = t * 0.05;
		u.splitOffset.value.set( Math.cos( a ) * 12, 1, Math.sin( a ) * 12 );

	};

}

// 镜头：远景环绕 → 贴近鱼群边缘滑过 → 逆光剪影 → 从鱼群下方仰拍
// exposure：像摄影师一样按镜头调曝光。迎光镜头压低曝光，亮水面保持明亮，鱼群压成剪影
const SHOTS = [
	{ name: 'orbit', duration: 26, exposure: 1.0 },
	{ name: 'glide', duration: 16, exposure: 1.0 },
	{ name: 'orbit', duration: 12, exposure: 1.0 },
	{ name: 'backlit', duration: 18, exposure: 0.42 },
	{ name: 'orbit', duration: 10, exposure: 1.0 },
	{ name: 'low', duration: 14, exposure: 0.75 },
];

export function createCameraDirector( camera, forcedShot = null ) {

	let index = forcedShot ? Math.max( 0, SHOTS.findIndex( ( s ) => s.name === forcedShot ) ) : 0;
	let timeInShot = 0;
	const lookAt = new THREE.Vector3();
	const lookTarget = new THREE.Vector3();
	const desired = new THREE.Vector3();
	const desiredLook = new THREE.Vector3();
	let first = true;
	let exposure = 1;

	return function update( dt, t, target, zoom, parallax ) {

		timeInShot += dt;
		if ( ! forcedShot && timeInShot > SHOTS[ index ].duration ) {

			timeInShot = 0;
			index = ( index + 1 ) % SHOTS.length;

		}

		const shot = SHOTS[ index ].name;
		const progress = timeInShot / SHOTS[ index ].duration;

		lookAt.lerp( target, first ? 1 : 1 - Math.exp( - dt * 0.6 ) );
		const a = t * 0.035 + parallax.x * 0.06;

		if ( shot === 'glide' ) {

			// 沿鱼群外缘快速横移，看清一条条鱼的银鳞与摆尾
			const a2 = a + ( progress - 0.5 ) * 1.4;
			const R = 22 * zoom;
			desired.set( lookAt.x + Math.sin( a2 ) * R, lookAt.y + 1.5 + parallax.y, lookAt.z + Math.cos( a2 ) * R );
			desiredLook.set( lookAt.x, lookAt.y + 0.5, lookAt.z );

		} else if ( shot === 'backlit' ) {

			// 逆光剪影：镜头在鱼群下方、背对太阳一侧，迎着阳光仰望，
			// 鱼群挡在光源前，边缘被勾出亮边，光柱从鱼群缝隙中射出
			// 太阳偏在鱼群边缘外约 15°：鱼群挡住的是明亮的水面，而不是太阳本身，避免过曝
			const D = 18 * zoom;
			const drift = t * 0.05;
			desired.copy( lookAt ).addScaledVector( SUN_DIR, - D );
			desired.x += Math.cos( drift ) * 6 + parallax.x * 2;
			desired.z += Math.sin( drift ) * 6;
			desired.y += parallax.y;
			desiredLook.copy( lookAt ).addScaledVector( SUN_DIR, 1.5 );

		} else if ( shot === 'low' ) {

			// 从鱼群下方仰拍：鱼群遮挡透光的水面，形成剪影
			const R = 16 * zoom;
			desired.set( lookAt.x + Math.sin( a ) * R, lookAt.y - 14 + parallax.y, lookAt.z + Math.cos( a ) * R );
			desiredLook.set( lookAt.x, lookAt.y + 3, lookAt.z );

		} else {

			const R = 40 * zoom;
			desired.set( lookAt.x + Math.sin( a ) * R, lookAt.y - 7 + Math.sin( t * 0.07 ) * 5 + parallax.y * 1.5, lookAt.z + Math.cos( a ) * R );
			desiredLook.set( lookAt.x, lookAt.y + 3.5, lookAt.z );

		}

		desired.y = THREE.MathUtils.clamp( desired.y, FLOOR_Y + 4, SURFACE_Y - 3 );

		// 镜头之间缓慢推移，而不是硬切
		const k = first ? 1 : 1 - Math.exp( - dt * 0.45 );
		camera.position.lerp( desired, k );
		lookTarget.lerp( desiredLook, first ? 1 : 1 - Math.exp( - dt * 0.8 ) );
		camera.lookAt( lookTarget );
		camera.updateMatrixWorld();
		exposure += ( SHOTS[ index ].exposure - exposure ) * ( first ? 1 : 1 - Math.exp( - dt * 0.5 ) );
		first = false;

		return { lookAt, exposure };

	};

}
