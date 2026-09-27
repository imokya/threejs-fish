// 鱼的程序化几何体与材质：GPU 实例化，顶点着色器中完成朝向与摆尾
import * as THREE from 'three/webgpu';
import {
	Fn, instanceIndex, positionLocal, normalLocal, positionGeometry, positionWorld, normalWorld, attribute,
	cameraPosition, vec2, vec3, float, sin, cos, normalize, cross, mix, smoothstep, clamp, hash, varying, length, max, abs,
} from 'three/tsl';
import { causticAt, lightTransmittance } from './ocean.js';

function createFishGeometry() {

	const pos = [];
	const nor = [];
	const part = [];
	const idx = [];

	const RINGS = 16;
	const SEG = 12;
	const zNose = 0.5;
	const zTail = - 0.3;

	const profileH = ( t ) => Math.max( 0.118 * 2.25 * Math.pow( t, 0.5 ) * Math.pow( 1 - t, 0.85 ), 0.014 );
	const profileW = ( t ) => profileH( t ) * ( 0.52 - 0.12 * t );

	// 鼻尖
	pos.push( 0, 0.004, zNose + 0.012 );
	nor.push( 0, 0, 1 );
	part.push( 0 );

	for ( let r = 0; r < RINGS; r ++ ) {

		const t = 0.02 + ( r / ( RINGS - 1 ) ) * 0.98;
		const z = zNose + ( zTail - zNose ) * t;
		const h = profileH( t );
		const w = profileW( t );

		for ( let s = 0; s < SEG; s ++ ) {

			const a = ( s / SEG ) * Math.PI * 2;
			// 背部略平、腹部略圆
			const y = Math.sin( a ) * h * ( Math.sin( a ) > 0 ? 1.0 : 0.92 );
			pos.push( Math.cos( a ) * w, y, z );
			nor.push( 0, 0, 0 );
			part.push( 0 );

		}

	}

	const ring = ( r, s ) => 1 + r * SEG + ( ( s + SEG ) % SEG );

	for ( let s = 0; s < SEG; s ++ ) idx.push( 0, ring( 0, s + 1 ), ring( 0, s ) );

	for ( let r = 0; r < RINGS - 1; r ++ ) {

		for ( let s = 0; s < SEG; s ++ ) {

			const a = ring( r, s ), b = ring( r, s + 1 ), c = ring( r + 1, s ), d = ring( r + 1, s + 1 );
			idx.push( a, b, c, b, d, c );

		}

	}

	// 尾端封口
	const tailCenter = pos.length / 3;
	pos.push( 0, 0, zTail - 0.005 );
	nor.push( 0, 0, - 1 );
	part.push( 0 );
	for ( let s = 0; s < SEG; s ++ ) idx.push( tailCenter, ring( RINGS - 1, s ), ring( RINGS - 1, s + 1 ) );

	const bodyGeo = new THREE.BufferGeometry();
	bodyGeo.setAttribute( 'position', new THREE.Float32BufferAttribute( pos, 3 ) );
	bodyGeo.setAttribute( 'normal', new THREE.Float32BufferAttribute( nor, 3 ) );
	bodyGeo.setAttribute( 'part', new THREE.Float32BufferAttribute( part, 1 ) );
	bodyGeo.setIndex( idx );
	bodyGeo.computeVertexNormals();

	// 鳍（平面三角形，双面渲染）
	const finPos = [];
	const finNor = [];
	const tri = ( a, b, c ) => {

		finPos.push( ...a, ...b, ...c );
		const n = new THREE.Vector3().crossVectors(
			new THREE.Vector3( ...b ).sub( new THREE.Vector3( ...a ) ),
			new THREE.Vector3( ...c ).sub( new THREE.Vector3( ...a ) )
		).normalize();
		for ( let i = 0; i < 3; i ++ ) finNor.push( n.x, n.y, n.z );

	};

	// 叉形尾鳍
	const tb = zTail + 0.03;
	tri( [ 0, 0.022, tb ], [ 0, 0.15, - 0.53 ], [ 0, 0.0, - 0.42 ] );
	tri( [ 0, 0.022, tb ], [ 0, 0.0, - 0.42 ], [ 0, - 0.022, tb ] );
	tri( [ 0, - 0.022, tb ], [ 0, 0.0, - 0.42 ], [ 0, - 0.14, - 0.52 ] );
	// 背鳍
	tri( [ 0, 0.1, 0.14 ], [ 0, 0.175, 0.02 ], [ 0, 0.092, - 0.04 ] );
	// 臀鳍
	tri( [ 0, - 0.06, - 0.12 ], [ 0, - 0.105, - 0.2 ], [ 0, - 0.04, - 0.22 ] );
	// 胸鳍
	for ( const sx of [ - 1, 1 ] ) {

		tri( [ sx * 0.045, - 0.03, 0.3 ], [ sx * 0.1, - 0.085, 0.17 ], [ sx * 0.045, - 0.05, 0.22 ] );

	}

	const finGeo = new THREE.BufferGeometry();
	finGeo.setAttribute( 'position', new THREE.Float32BufferAttribute( finPos, 3 ) );
	finGeo.setAttribute( 'normal', new THREE.Float32BufferAttribute( finNor, 3 ) );
	finGeo.setAttribute( 'part', new THREE.Float32BufferAttribute( new Array( finPos.length / 3 ).fill( 1 ), 1 ) );

	return mergeGeometries( bodyGeo, finGeo );

}

// 合并身体（索引）与鳍（非索引），保持索引几何以复用顶点着色结果
function mergeGeometries( a, b ) {

	const g = new THREE.BufferGeometry();
	const aCount = a.getAttribute( 'position' ).count;
	const bCount = b.getAttribute( 'position' ).count;

	for ( const name of [ 'position', 'normal', 'part' ] ) {

		const aa = a.getAttribute( name );
		const bb = b.getAttribute( name );
		const arr = new Float32Array( aa.array.length + bb.array.length );
		arr.set( aa.array, 0 );
		arr.set( bb.array, aa.array.length );
		g.setAttribute( name, new THREE.BufferAttribute( arr, aa.itemSize ) );

	}

	const index = Array.from( a.getIndex().array );
	for ( let i = 0; i < bCount; i ++ ) index.push( aCount + i );
	g.setIndex( index );

	return g;

}

export function createFish( boids, count ) {

	const geometry = createFishGeometry();

	const material = new THREE.MeshPhysicalNodeMaterial( {
		side: THREE.DoubleSide,
		iridescence: 0.55,
		iridescenceIOR: 1.35,
		iridescenceThicknessRange: [ 250, 520 ],
	} );

	const variation = varying( hash( instanceIndex ), 'vFishVar' );
	const hueVar = varying( hash( instanceIndex.add( 313 ) ), 'vFishHue' );

	material.positionNode = Fn( () => {

		const P = boids.positions.element( instanceIndex );
		const V = boids.velocities.element( instanceIndex );

		const seed = hash( instanceIndex.add( 7919 ) );
		// 个体大小差异；鱼群外围的鱼稍小、核心的鱼稍大
		const dCenter = length( P.xyz.sub( boids.uniforms.target ) );
		const scale = mix( 0.8, 1.2, seed ).mul( mix( 1.12, 0.86, smoothstep( 4, 16, dCenter ) ) );

		const local = positionLocal.toVar();
		const n = normalLocal.toVar();

		// 身体的行波摆动：越靠近尾部幅度越大
		const along = clamp( float( 0.5 ).sub( local.z ), 0, 1.05 );
		const amp = along.mul( along ).mul( 0.13 ).add( 0.008 );
		const k = float( 5.2 );
		const wave = P.w.sub( along.mul( k ) );
		local.x.addAssign( sin( wave ).mul( amp ) );
		// 法线随之偏转
		const slope = cos( wave ).mul( amp ).mul( k ).add( sin( wave ).mul( along.mul( 0.26 ) ) );
		n.assign( normalize( vec3( n.x, n.y, n.z.add( n.x.mul( slope ) ) ) ) );

		// 转弯时向内侧倾斜，鳞片角度随之变化，泛起自然的细碎银光
		const bank = boids.banks.element( instanceIndex );
		const cb = cos( bank ), sb = sin( bank );
		local.assign( vec3( local.x.mul( cb ).sub( local.y.mul( sb ) ), local.x.mul( sb ).add( local.y.mul( cb ) ), local.z ) );
		n.assign( vec3( n.x.mul( cb ).sub( n.y.mul( sb ) ), n.x.mul( sb ).add( n.y.mul( cb ) ), n.z ) );

		// 由速度方向构建朝向
		const fwd = normalize( V.xyz );
		const right = normalize( cross( vec3( 0, 1, 0 ), fwd ).add( vec3( 0.0001, 0, 0 ) ) );
		const up = cross( fwd, right );

		const world = right.mul( local.x ).add( up.mul( local.y ) ).add( fwd.mul( local.z ) ).mul( scale ).add( P.xyz );
		normalLocal.assign( right.mul( n.x ).add( up.mul( n.y ) ).add( fwd.mul( n.z ) ) );

		return world;

	} )();

	const part = attribute( 'part', 'float' );
	const g = positionGeometry;

	// 沙丁鱼式配色：深蓝绿色背部、银色体侧、白色腹部、青色体侧线
	const albedo = Fn( () => {

		// 背色在偏绿与偏蓝之间略有差异
		const back = mix( vec3( 0.02, 0.1, 0.12 ), vec3( 0.025, 0.08, 0.16 ), hueVar );
		const flank = vec3( 0.7, 0.78, 0.84 );
		const belly = vec3( 0.92, 0.94, 0.96 );
		// 深色鱼背向下延伸到体侧上部，远看也能分辨出鱼形
		const c = mix( flank, back, smoothstep( - 0.005, 0.05, g.y ) ).toVar();
		c.assign( mix( c, belly, float( 1 ).sub( smoothstep( - 0.08, - 0.015, g.y ) ) ) );
		// 体侧线
		const stripe = float( 1 ).sub( smoothstep( 0.0, 0.01, abs( g.y.sub( 0.03 ) ) ) ).mul( float( 1 ).sub( smoothstep( 0.3, 0.46, g.z ) ) );
		c.assign( mix( c, vec3( 0.06, 0.3, 0.4 ), stripe.mul( 0.75 ) ) );
		// 背部斑点
		const spots = smoothstep( 0.55, 0.9, sin( g.z.mul( 90 ) ).mul( sin( g.x.mul( 140 ) ) ) ).mul( smoothstep( 0.035, 0.07, g.y ) );
		c.assign( mix( c, vec3( 0.0, 0.02, 0.04 ), spots.mul( 0.5 ) ) );
		// 细密鳞片：只在近景可见的微弱明暗纹理
		const scales = sin( g.z.mul( 260 ).add( sin( g.y.mul( 320 ) ).mul( 1.3 ) ) ).mul( sin( g.y.mul( 260 ) ) );
		c.mulAssign( scales.mul( 0.06 ).add( 1 ) );
		// 眼睛
		const eye = float( 1 ).sub( smoothstep( 0.013, 0.018, length( vec2( g.y.sub( 0.018 ), g.z.sub( 0.405 ) ) ) ) ).mul( smoothstep( 0.01, 0.03, abs( g.x ) ) );
		c.assign( mix( c, vec3( 0.01 ), eye ) );
		// 鳍：半透明感的淡灰蓝
		c.assign( mix( c, vec3( 0.22, 0.32, 0.36 ), part ) );
		// 个体差异
		c.mulAssign( mix( 0.82, 1.12, variation ) );
		return c;

	} )();

	// 背部的焦散光斑与随深度的光衰减
	// 鱼背上只保留淡淡的焦散光斑；深度衰减减半（环境反射本身已包含水下色调，不重复压暗）
	const causticLight = causticAt( positionWorld ).mul( max( normalWorld.y, 0 ) ).mul( 0.5 );
	material.colorNode = albedo.mul( mix( vec3( 1 ), lightTransmittance( positionWorld.y ), 0.5 ) ).mul( causticLight.add( 1 ) );
	// 镜面银鳞：高金属度让体侧像镜子一样反射水面的亮光，与深色背部形成强烈反差
	material.metalnessNode = mix( mix( 0.9, 0.3, smoothstep( - 0.005, 0.05, g.y ) ), 0.1, part );
	// 高光抗锯齿：远处的鱼只占几个像素，粗糙度随距离增加，避免高光一帧有一帧无地闪烁
	const viewDist = length( positionWorld.sub( cameraPosition ) );
	const baseRough = mix( float( 0.16 ), float( 0.4 ), smoothstep( 12, 60, viewDist ) );
	material.roughnessNode = mix( baseRough, float( 0.55 ), part );

	const mesh = new THREE.Mesh( geometry, material );
	mesh.count = count;
	mesh.frustumCulled = false;
	mesh.castShadow = true;
	mesh.receiveShadow = true;

	return mesh;

}
