// 水体共享参数与 TSL 函数：水色、光衰减、焦散
import { Vector3 } from 'three/webgpu';
import {
	Fn, vec2, vec3, float, time, sin, cos, abs, pow, exp, max, mix, smoothstep, dot, mx_noise_float, uniform,
} from 'three/tsl';

export const SURFACE_Y = 26;
export const FLOOR_Y = -22;

// 指向太阳的方向（水下折射后的光线方向）：高度约 55°，光柱斜射入水，更有电影感
export const SUN_DIR = new Vector3( 0.62, 1.0, 0.3 ).normalize();
export const sunDir = uniform( SUN_DIR );

// 海水的消光系数（每单位距离），红光衰减最快 —— 形成真实的蓝绿色调
// 水的浑浊度倍率（调节面板可改）：1 = 清澈的热带海水
export const waterDensity = uniform( 1 );
// 视线方向的消光（红光衰减最快）
export const EXTINCTION = vec3( 0.048, 0.017, 0.012 ).mul( waterDensity );
// 阳光从水面向下传播时的衰减：越深略暗、略蓝
export const LIGHT_EXTINCTION = vec3( 0.04, 0.014, 0.01 ).mul( waterDensity );

// 不同方向上的水体散射颜色（线性空间）
export const waterColor = /*@__PURE__*/ Fn( ( [ dir ] ) => {

	const up = dir.y;
	const deep = vec3( 0.0, 0.003, 0.018 );
	const mid = vec3( 0.0, 0.045, 0.12 );
	const top = vec3( 0.03, 0.34, 0.5 );
	const c = mix( deep, mid, smoothstep( - 0.85, 0.05, up ) ).toVar();
	c.assign( mix( c, top, pow( smoothstep( - 0.05, 1.0, up ), 1.4 ) ) );
	// 太阳方向的前向散射光晕
	const s = max( dot( dir, sunDir ), 0.0 );
	c.addAssign( vec3( 0.2, 0.6, 0.62 ).mul( pow( s, 6.0 ).mul( 0.3 ).add( pow( s, 48.0 ).mul( 0.8 ) ) ) );
	return c;

} );

// 某深度处接收到的阳光透射率
export const lightTransmittance = /*@__PURE__*/ Fn( ( [ y ] ) => {

	const d = max( float( SURFACE_Y ).sub( y ), 0.0 ).div( sunDir.y );
	return exp( LIGHT_EXTINCTION.mul( d ).negate() );

} );

// 将世界坐标沿光线方向投影到水面
export const surfaceProjection = /*@__PURE__*/ Fn( ( [ p ] ) => {

	const d = max( float( SURFACE_Y ).sub( p.y ), 0.0 );
	return p.xz.add( sunDir.xz.mul( d.div( sunDir.y ) ) );

} );

// ---------- 云影 ----------
// 天上的云缓缓飘过，水下的光线随之时明时暗。
// 图案只用三角函数，CPU 端可以精确复现（用来同步调节太阳光强度）
export const cloudTime = uniform( 0 );

const CLOUD = { fx: 0.013, fy: 0.009, gx: 0.007, gy: 0.011, s1: 0.16, s2: 0.06, s3: 0.11, s4: 0.075 };

export const cloudShade = /*@__PURE__*/ Fn( ( [ q ] ) => {

	const t = cloudTime;
	const f = sin( q.x.mul( CLOUD.fx ).add( t.mul( CLOUD.s1 ) ).add( sin( q.y.mul( CLOUD.fy ).add( t.mul( CLOUD.s2 ) ) ).mul( 1.7 ) ) )
		.add( sin( q.y.mul( CLOUD.gy ).sub( t.mul( CLOUD.s3 ) ).add( sin( q.x.mul( CLOUD.gx ).sub( t.mul( CLOUD.s4 ) ) ).mul( 1.3 ) ) ) )
		.mul( 0.5 );
	return float( 1 ).sub( smoothstep( - 0.45, 0.55, f ).mul( 0.25 ) );

} );

export function cloudShadeJS( x, z, t ) {

	const f = 0.5 * ( Math.sin( x * CLOUD.fx + t * CLOUD.s1 + Math.sin( z * CLOUD.fy + t * CLOUD.s2 ) * 1.7 )
		+ Math.sin( z * CLOUD.gy - t * CLOUD.s3 + Math.sin( x * CLOUD.gx - t * CLOUD.s4 ) * 1.3 ) );
	const k = Math.min( Math.max( ( f + 0.45 ) / 1.0, 0 ), 1 );
	return 1 - k * k * ( 3 - 2 * k ) * 0.25;

}

// 细腻的焦散图案（用于海底、岩石、鱼背）
export const caustic = /*@__PURE__*/ Fn( ( [ q, soft ] ) => {

	const t = time.mul( 0.55 );
	const p = q.mul( 0.34 ).toVar();
	// 正弦域扭曲，模拟波面折射
	p.addAssign( vec2(
		sin( p.y.mul( 0.9 ).add( t.mul( 0.7 ) ) ).add( sin( p.y.mul( 0.37 ).sub( t.mul( 0.4 ) ) ) ),
		cos( p.x.mul( 0.8 ).sub( t.mul( 0.6 ) ) ).add( sin( p.x.mul( 0.41 ).add( t.mul( 0.5 ) ) ) )
	).mul( 0.45 ) );
	const n1 = mx_noise_float( vec3( p, t.mul( 0.45 ) ) );
	const n2 = mx_noise_float( vec3( p.mul( 1.93 ).add( 7.3 ), t.mul( 0.6 ) ) );
	// 越深焦散越散焦：线条变粗变柔、对比度降低
	const k = mix( float( 9.0 ), float( 4.0 ), soft );
	const c1 = pow( float( 1 ).sub( abs( n1 ) ), k );
	const c2 = pow( float( 1 ).sub( abs( n2 ) ), k );
	return mix( c1.mul( 0.9 ).add( c2.mul( 0.55 ) ), float( 0.3 ), soft.mul( 0.45 ) );

} );

// 带色散的焦散（RGB 三通道轻微偏移）
export const causticRGB = /*@__PURE__*/ Fn( ( [ q, soft ] ) => {

	return vec3(
		caustic( q.mul( 0.985 ), soft ),
		caustic( q, soft ),
		caustic( q.mul( 1.015 ).add( 0.03 ), soft )
	);

} );

const causticSoftness = ( p ) => smoothstep( 10.0, 80.0, float( SURFACE_Y ).sub( p.y ) ).mul( 0.5 );

// 世界坐标处的焦散（自动投影到水面并按深度柔化）
// 世界坐标处的焦散（自动投影到水面、按深度柔化，并随云影明暗）
export const causticAt = ( p ) => {

	const q = surfaceProjection( p );
	return caustic( q, causticSoftness( p ) ).mul( cloudShade( q ) );

};

export const causticRGBAt = ( p ) => {

	const q = surfaceProjection( p );
	return causticRGB( q, causticSoftness( p ) ).mul( cloudShade( q ) );

};

// 宽大柔和的光柱图案（用于体积光）
export const shaftPattern = /*@__PURE__*/ Fn( ( [ q, depth ] ) => {

	const t = time.mul( 0.35 );
	// 水面大尺度涌浪带动光柱整体缓慢摇曳
	const sway = vec2( sin( time.mul( 0.23 ) ).add( sin( time.mul( 0.61 ) ).mul( 0.4 ) ), cos( time.mul( 0.19 ) ) ).mul( 2.2 );
	const p = q.add( sway ).mul( 0.085 ).toVar();
	p.addAssign( vec2( sin( p.y.mul( 2.1 ).add( t ) ), cos( p.x.mul( 1.7 ).sub( t.mul( 0.8 ) ) ) ).mul( 0.35 ) );
	const n = mx_noise_float( vec3( p, t.mul( 0.5 ) ) );
	const ridge = pow( float( 1 ).sub( abs( n ) ), 10.0 ).mul( 1.8 );
	// 越深越散焦；云影下光柱减弱
	return mix( float( 0.03 ), ridge, exp( depth.mul( - 0.012 ) ) ).mul( cloudShade( q ) );

} );
