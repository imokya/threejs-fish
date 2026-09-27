// 动态瞬间：受惊爆散再合拢、鱼流擦镜而过
import * as THREE from 'three/webgpu';
import { SURFACE_Y, FLOOR_Y } from './ocean.js';

const FLYBY_DURATION = 15;
const NORMAL_MAX_SPEED = 6.2;
const FLYBY_MAX_SPEED = 10.5;

export function createEvents( u, camera, formations, director ) {

	const state = {
		autoBurst: true,
		autoFlyby: true,
	};

	let burstTimer = 40; // 首次爆散：鱼群成形后
	let flybyTimer = 62; // 首次鱼流
	let flyby = null;

	const tmp = new THREE.Vector3();
	const target = new THREE.Vector3();

	// 受惊爆散：鱼群中心附近突然"炸开"，恐慌沿鱼群传播，几秒后重新收拢
	function burst( center ) {

		u.burstPoint.value.copy( center ).add( tmp.randomDirection().multiplyScalar( 2.5 ) );
		u.burst.value = 1;

	}

	// 鱼流擦镜而过：镜头定格，鱼群被一个移动的目标点牵引，
	// 拉成长长的鱼流从镜头前方几米处高速掠过
	function startFlyby( schoolCenter ) {

		const cam = camera.position.clone();
		const forward = camera.getWorldDirection( new THREE.Vector3() ).setY( 0 ).normalize();
		const side = new THREE.Vector3().crossVectors( forward, new THREE.Vector3( 0, 1, 0 ) ).normalize();
		const clampY = ( v ) => v.setY( THREE.MathUtils.clamp( v.y, FLOOR_Y + 7, SURFACE_Y - 7 ) );

		// 经过点：镜头前方约 9 米、略高于镜头
		const near = clampY( cam.clone().addScaledVector( forward, 9 ).add( new THREE.Vector3( 0, 1.5, 0 ) ) );
		// 从鱼群所在处出发，掠过镜头前方，冲向画面另一侧的远处
		const p0 = schoolCenter.clone();
		const exitSide = side.clone().multiplyScalar( Math.sign( side.dot( tmp.copy( near ).sub( p0 ) ) ) || 1 );
		const p2 = clampY( near.clone().addScaledVector( exitSide, 45 ).addScaledVector( forward, 12 ) );

		flyby = { p0, near, p2, time: 0 };
		director.hold = { position: cam };
		formations.override = 'ball';
		u.maxSpeed.value = FLYBY_MAX_SPEED;

	}

	function endFlyby() {

		flyby = null;
		director.hold = null;
		formations.override = null;
		u.maxSpeed.value = NORMAL_MAX_SPEED;

	}

	// 返回本帧鱼群应追随的目标点（鱼流期间被事件接管）
	function update( dt, baseTarget ) {

		if ( flyby ) {

			flyby.time += dt;
			const s = Math.min( flyby.time / FLYBY_DURATION, 1 );
			// 先快速冲向镜头前方，再掠过、远去
			const e = s < 0.45 ? ( s / 0.45 ) * 0.5 : 0.5 + ( ( s - 0.45 ) / 0.55 ) * 0.5;
			const a = ( 1 - e ) * ( 1 - e ), b = 2 * ( 1 - e ) * e, c = e * e;
			target.set( 0, 0, 0 ).addScaledVector( flyby.p0, a ).addScaledVector( flyby.near, b ).addScaledVector( flyby.p2, c );
			if ( s >= 1 ) endFlyby();
			return target;

		}

		if ( state.autoBurst ) {

			burstTimer -= dt;
			if ( burstTimer <= 0 ) {

				burstTimer = 45 + Math.random() * 30;
				burst( baseTarget );

			}

		}

		if ( state.autoFlyby ) {

			flybyTimer -= dt;
			if ( flybyTimer <= 0 ) {

				flybyTimer = 70 + Math.random() * 30;
				startFlyby( baseTarget );

			}

		}

		return baseTarget;

	}

	return {
		state,
		update,
		burstNow: () => burst( u.target.value ),
		flybyNow: () => {

			if ( ! flyby ) startFlyby( u.target.value );

		},
		get active() {

			return flyby !== null;

		},
	};

}
