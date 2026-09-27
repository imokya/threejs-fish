// 水下环境：海底沙地、礁石、海藻、从下方仰望的水面、漂浮微粒、背景与环境反射
import * as THREE from 'three/webgpu';
import {
	Fn, uv, time, uniformArray, positionWorld, positionLocal, normalWorld, cameraPosition, instanceIndex, hash,
	vec2, vec3, vec4, float, sin, cos, pow, max, min, mix, sqrt, dot, normalize, reflect, smoothstep, length, exp, mod, clamp, step,
	mx_noise_float,
} from 'three/tsl';
import { pointer } from './pointer.js';
import {
	SURFACE_Y, FLOOR_Y, SUN_DIR, EXTINCTION, sunDir, waterColor, lightTransmittance, surfaceProjection, causticAt, causticRGBAt, cloudShade,
} from './ocean.js';

// ---------- CPU 端噪声，用于地形与礁石 ----------
function hash2( x, y ) {

	const s = Math.sin( x * 127.1 + y * 311.7 ) * 43758.5453;
	return s - Math.floor( s );

}

function valueNoise( x, y ) {

	const ix = Math.floor( x ), iy = Math.floor( y );
	const fx = x - ix, fy = y - iy;
	const ux = fx * fx * ( 3 - 2 * fx ), uy = fy * fy * ( 3 - 2 * fy );
	const a = hash2( ix, iy ), b = hash2( ix + 1, iy ), c = hash2( ix, iy + 1 ), d = hash2( ix + 1, iy + 1 );
	return a + ( b - a ) * ux + ( c - a ) * uy + ( a - b - c + d ) * ux * uy;

}

function fbm( x, y, oct = 5 ) {

	let v = 0, a = 0.5, f = 1;
	for ( let i = 0; i < oct; i ++ ) {

		v += a * valueNoise( x * f, y * f );
		f *= 2.03;
		a *= 0.5;

	}

	return v;

}

export function floorHeight( x, z ) {

	const dunes = fbm( x * 0.018, z * 0.018 ) * 7.0 - 3.5;
	const ripples = Math.sin( x * 0.55 + Math.sin( z * 0.08 ) * 3.0 ) * 0.12;
	// 远处地势抬升，营造海盆感
	const r = Math.hypot( x, z );
	const basin = 14 * THREE.MathUtils.smoothstep( r, 55, 190 );
	return FLOOR_Y + dunes + ripples + basin;

}

// ---------- 海底 ----------
function createSeabed() {

	const geo = new THREE.PlaneGeometry( 1000, 1000, 400, 400 );
	geo.rotateX( - Math.PI / 2 );
	const p = geo.attributes.position;
	for ( let i = 0; i < p.count; i ++ ) p.setY( i, floorHeight( p.getX( i ), p.getZ( i ) ) );
	geo.computeVertexNormals();

	const mat = new THREE.MeshStandardNodeMaterial( { roughness: 0.92, metalness: 0 } );
	const w = positionWorld;
	const sandVar = mx_noise_float( vec3( w.xz.mul( 0.12 ), 0 ) ).mul( 0.5 ).add( 0.5 );
	const grain = mx_noise_float( vec3( w.xz.mul( 3.1 ), 1.7 ) ).mul( 0.08 );
	const sand = mix( vec3( 0.6, 0.57, 0.49 ), vec3( 0.8, 0.76, 0.65 ), sandVar ).add( grain );
	const caus = causticRGBAt( w );
	// 焦散调制反照率 —— 这样鱼群的阴影也会遮住焦散光斑
	mat.colorNode = sand.mul( lightTransmittance( w.y ) ).mul( caus.mul( 2.2 ).add( 0.46 ) );

	const mesh = new THREE.Mesh( geo, mat );
	mesh.receiveShadow = true;
	return mesh;

}

// ---------- 礁石 ----------
function createRocks() {

	const group = new THREE.Group();
	const mat = new THREE.MeshStandardNodeMaterial( { roughness: 0.85, metalness: 0 } );
	const w = positionWorld;
	const moss = smoothstep( 0.35, 0.85, normalWorld.y );
	const n = mx_noise_float( vec3( w.mul( 0.9 ) ) ).mul( 0.5 ).add( 0.5 );
	const base = mix( vec3( 0.22, 0.2, 0.19 ), vec3( 0.36, 0.33, 0.3 ), n );
	const col = mix( base, vec3( 0.2, 0.3, 0.12 ), moss.mul( 0.7 ) );
	const caus = causticRGBAt( w ).mul( max( normalWorld.y, 0 ) );
	mat.colorNode = col.mul( lightTransmittance( w.y ) ).mul( caus.mul( 1.6 ).add( 0.62 ) );

	const rnd = mulberry32( 7 );
	for ( let i = 0; i < 26; i ++ ) {

		const geo = new THREE.IcosahedronGeometry( 1, 4 );
		const pa = geo.attributes.position;
		const seed = rnd() * 100;
		for ( let j = 0; j < pa.count; j ++ ) {

			const v = new THREE.Vector3().fromBufferAttribute( pa, j );
			const d = 1 + ( fbm( v.x * 0.8 + seed, v.y * 0.8 + v.z * 0.6 + seed, 3 ) - 0.5 ) * 0.7;
			v.multiplyScalar( d );
			pa.setXYZ( j, v.x, v.y, v.z );

		}

		geo.computeVertexNormals();
		const m = new THREE.Mesh( geo, mat );
		const a = rnd() * Math.PI * 2;
		const r = 14 + rnd() * 55;
		const x = Math.cos( a ) * r, z = Math.sin( a ) * r;
		const s = 1.5 + rnd() * rnd() * 7;
		m.scale.set( s * ( 0.8 + rnd() * 0.8 ), s * ( 0.5 + rnd() * 0.6 ), s * ( 0.8 + rnd() * 0.8 ) );
		m.position.set( x, floorHeight( x, z ) + s * 0.15, z );
		m.rotation.set( rnd() * 0.4, rnd() * Math.PI * 2, rnd() * 0.4 );
		m.castShadow = true;
		m.receiveShadow = true;
		group.add( m );

	}

	return group;

}

// ---------- 海藻 ----------
function createKelp() {

	const COUNT = 220;
	const geo = new THREE.PlaneGeometry( 1, 1, 1, 24 );
	geo.translate( 0, 0.5, 0 );
	const p = geo.attributes.position;
	for ( let i = 0; i < p.count; i ++ ) {

		const y = p.getY( i );
		const taper = ( 1 - y * 0.75 ) * ( 0.75 + 0.25 * Math.sin( y * 38 ) );
		p.setX( i, p.getX( i ) * taper );

	}

	geo.computeVertexNormals();

	const mat = new THREE.MeshStandardNodeMaterial( { side: THREE.DoubleSide, roughness: 0.55, metalness: 0 } );
	const h = uv().y;

	mat.positionNode = Fn( () => {

		const p = positionLocal.toVar();
		const h2 = h.mul( h );
		p.x.addAssign( sin( time.mul( 0.55 ).add( p.x.mul( 0.21 ) ).add( h.mul( 2.2 ) ) ).mul( h2 ).mul( 2.4 ) );
		p.z.addAssign( cos( time.mul( 0.42 ).add( p.z.mul( 0.17 ) ).add( h.mul( 1.7 ) ) ).mul( h2 ).mul( 1.8 ) );
		return p;

	} )();

	const col = mix( vec3( 0.07, 0.1, 0.025 ), vec3( 0.42, 0.38, 0.1 ), h );
	const caus = causticAt( positionWorld );
	mat.colorNode = col.mul( lightTransmittance( positionWorld.y ) ).mul( caus.mul( 1.5 ).add( 0.8 ) );
	// 逆光时叶片透出的暖光
	mat.emissiveNode = col.mul( lightTransmittance( positionWorld.y ) ).mul( 0.35 ).mul(
		pow( max( dot( normalize( positionWorld.sub( cameraPosition ) ), sunDir ), 0 ), 3 ).add( 0.08 )
	);

	const mesh = new THREE.InstancedMesh( geo, mat, COUNT );
	const rnd = mulberry32( 42 );
	const m4 = new THREE.Matrix4();
	const q = new THREE.Quaternion();
	const clusters = Array.from( { length: 14 }, () => {

		const a = rnd() * Math.PI * 2, r = 26 + rnd() * 45;
		return [ Math.cos( a ) * r, Math.sin( a ) * r ];

	} );

	for ( let i = 0; i < COUNT; i ++ ) {

		const c = clusters[ i % clusters.length ];
		const x = c[ 0 ] + ( rnd() - 0.5 ) * 12, z = c[ 1 ] + ( rnd() - 0.5 ) * 12;
		const height = 7 + rnd() * rnd() * 22;
		q.setFromEuler( new THREE.Euler( 0, rnd() * Math.PI, 0 ) );
		m4.compose( new THREE.Vector3( x, floorHeight( x, z ) - 0.3, z ), q, new THREE.Vector3( 0.45 + rnd() * 0.7, height, 1 ) );
		mesh.setMatrixAt( i, m4 );

	}

	mesh.castShadow = true;
	mesh.receiveShadow = true;
	mesh.frustumCulled = false;
	return mesh;

}

// ---------- 从水下仰望的水面（斯涅尔窗 + 全反射） ----------
function createSurface() {

	const geo = new THREE.PlaneGeometry( 1400, 1400, 1, 1 );
	geo.rotateX( Math.PI / 2 );
	geo.translate( 0, SURFACE_Y, 0 );

	const mat = new THREE.MeshBasicNodeMaterial( { side: THREE.DoubleSide } );
	const sunAbove = normalize( vec3( sunDir.x.mul( 1.35 ), sunDir.y, sunDir.z.mul( 1.35 ) ) );

	const waves = [
		[ 1.0, 0.2, 0.16, 0.9, 0.55 ], [ - 0.4, 1.0, 0.23, 1.1, 0.35 ], [ 0.7, - 0.7, 0.37, 1.4, 0.2 ],
		[ - 0.9, - 0.3, 0.58, 1.8, 0.12 ], [ 0.2, 0.95, 0.91, 2.3, 0.07 ], [ 0.85, 0.5, 1.37, 2.9, 0.045 ],
		[ - 0.6, 0.8, 2.1, 3.6, 0.028 ],
	];

	mat.colorNode = Fn( () => {

		const p = positionWorld.xz;
		const grad = vec2( 0 ).toVar();
		for ( const [ dx, dz, f, s, a ] of waves ) {

			const l = Math.hypot( dx, dz );
			const d = vec2( dx / l, dz / l );
			const ph = dot( d, p ).mul( f ).add( time.mul( s ) );
			grad.addAssign( d.mul( cos( ph ).mul( a * f ) ) );

		}

		// 细碎波纹（两级噪声），产生跳动的碎光
		const nx = mx_noise_float( vec3( p.mul( 0.9 ), time.mul( 0.8 ) ) );
		const nz = mx_noise_float( vec3( p.mul( 0.9 ).add( 17.3 ), time.mul( 0.8 ) ) );
		const fx = mx_noise_float( vec3( p.mul( 3.7 ), time.mul( 1.9 ) ) );
		const fz = mx_noise_float( vec3( p.mul( 3.7 ).add( 5.1 ), time.mul( 1.9 ) ) );
		grad.addAssign( vec2( nx, nz ).mul( 0.2 ).add( vec2( fx, fz ).mul( 0.07 ) ) );

		const n = normalize( vec3( grad.x.negate(), 1, grad.y.negate() ) );
		const v = normalize( positionWorld.sub( cameraPosition ) );
		const cosI = max( dot( v, n ), 0.0 );
		const sinI = sqrt( max( float( 1 ).sub( cosI.mul( cosI ) ), 0 ) );
		const s = sinI.mul( 1.333 );

		// 斯涅尔窗：临界角（约 48.6°）以内能看见天空，以外是全反射
		const inside = float( 1 ).sub( smoothstep( 0.95, 1.0, s ) );
		const fresnel = mix( float( 0.03 ), float( 1 ), pow( smoothstep( 0.5, 1.0, s ), 2.4 ) );

		const cosT = sqrt( max( float( 1 ).sub( s.mul( s ) ), 0 ) );
		const rdir = normalize( v.sub( n.mul( cosI ) ).mul( 1.333 ).add( n.mul( cosT ) ) );

		const sd = max( dot( rdir, sunAbove ), 0 );
		const sky = mix( vec3( 0.32, 0.62, 0.8 ), vec3( 0.85, 0.95, 1.0 ), rdir.y ).mul( 2.4 )
			.add( vec3( 1.0, 0.94, 0.82 ).mul( pow( sd, 900 ).mul( 120 ).add( pow( sd, 60 ).mul( 5 ) ).add( pow( sd, 10 ).mul( 1.2 ) ) ) );

		// 窗口边缘的彩色色散环
		const rim = smoothstep( 0.86, 0.95, s ).mul( float( 1 ).sub( smoothstep( 0.95, 1.0, s ) ) );
		const rimCol = vec3( 0.7, 1.0, 0.85 ).mul( rim ).mul( 1.2 );

		// 全反射：水面像镜子一样倒映出下方带焦散的海底
		const r = reflect( v, n );
		const down = max( r.y.negate(), 0.05 );
		const hitDist = float( SURFACE_Y - FLOOR_Y - 2 ).div( down );
		const hit = positionWorld.add( r.mul( hitDist ) );
		const seabed = vec3( 0.7, 0.66, 0.56 ).mul( lightTransmittance( hit.y ) ).mul( causticAt( hit ).mul( 3.0 ).add( 0.34 ) );
		const T2 = exp( EXTINCTION.mul( hitDist ).negate() );
		const mirror = seabed.mul( T2 ).add( waterColor( r ).mul( float( 1 ).sub( T2 ) ) ).mul( 1.15 );

		// 云飘过时，透光窗的天光变暗
		const skyShade = cloudShade( p ).mul( 0.5 ).add( 0.5 );
		return mix( mirror, sky.mul( skyShade ).add( rimCol ), inside.mul( float( 1 ).sub( fresnel ) ) );

	} )();

	const mesh = new THREE.Mesh( geo, mat );
	return mesh;

}

// ---------- 漂浮的海洋雪（随洋流漂移的悬浮颗粒） ----------
function createMarineSnow() {

	const COUNT = 7000;
	const BOX = 60;
	const mat = new THREE.SpriteNodeMaterial( {
		transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
	} );

	const r = vec3( hash( instanceIndex ), hash( instanceIndex.add( 1301 ) ), hash( instanceIndex.add( 2903 ) ) );
	// 整体洋流 + 每个颗粒自己的湍流晃动
	const current = vec3( time.mul( 0.55 ), time.mul( - 0.06 ), time.mul( 0.22 ) );
	const turb = vec3(
		sin( time.mul( 0.5 ).add( r.x.mul( 40 ) ) ).add( sin( time.mul( 1.3 ).add( r.y.mul( 17 ) ) ).mul( 0.35 ) ),
		sin( time.mul( 0.37 ).add( r.y.mul( 30 ) ) ),
		cos( time.mul( 0.43 ).add( r.z.mul( 50 ) ) ).add( cos( time.mul( 1.1 ).add( r.x.mul( 23 ) ) ).mul( 0.35 ) )
	).mul( 0.6 );
	const p = r.mul( BOX ).add( current ).add( turb );
	const rel = mod( p.sub( cameraPosition ).add( BOX / 2 ), BOX ).sub( BOX / 2 );
	const wp = cameraPosition.add( rel );
	// 手指划过时，附近的悬浮颗粒被拨开
	const fromRay = wp.sub( pointer.origin );
	const along = max( dot( fromRay, pointer.dir ), 0 );
	const away = fromRay.sub( pointer.dir.mul( along ) );
	const dAway = length( away ).max( 0.001 );
	const reach = along.mul( 0.06 ).add( 0.6 );
	const push = clamp( float( 1 ).sub( dAway.div( reach ) ), 0, 1 );
	mat.positionNode = wp.add( away.div( dAway ).mul( push.mul( push ).mul( reach ).mul( 0.9 ).mul( pointer.active ) ) );
	const size = pow( hash( instanceIndex.add( 4441 ) ), 4 );
	// 离镜头很近的颗粒失焦：变大、变柔、变淡，像镜头前飘过的光斑
	const nearCam = float( 1 ).sub( smoothstep( 0.6, 4.5, length( wp.sub( cameraPosition ) ) ) );
	const bokeh = nearCam.mul( 5.0 ).add( 1 );
	mat.scaleNode = mix( float( 0.02 ), float( 0.16 ), size ).mul( bokeh );

	const toP = positionWorld.sub( cameraPosition );
	const d = length( toP );
	const disc = float( 1 ).sub( smoothstep( mix( float( 0.05 ), float( 0.3 ), nearCam ), 0.5, length( uv().sub( 0.5 ) ) ) );
	const fade = exp( d.mul( - 0.055 ) ).mul( smoothstep( 0.3, 1.2, d ) ).div( bokeh.mul( bokeh ).mul( 0.35 ).add( 0.65 ) );
	// 颗粒被阳光照亮，迎着光看时因前向散射更亮
	const glow = pow( max( dot( toP.div( d ), sunDir ), 0 ), 4 ).mul( 2.5 ).add( 0.6 );
	const brightness = disc.mul( fade ).mul( glow ).mul( mix( float( 3.2 ), float( 1.3 ), size ) );
	mat.colorNode = vec4( vec3( 0.6, 0.88, 0.92 ).mul( lightTransmittance( positionWorld.y ) ).mul( brightness ), 1 );

	const sprite = new THREE.Sprite( mat );
	sprite.count = COUNT;
	sprite.frustumCulled = false;
	return sprite;

}

// 气泡着色：透明球体，中心几乎透明，边缘全反射呈银色，上半部反射明亮水面、下半部偏暗，顶部一点高光
export function applyBubbleShading( mat, fade = float( 1 ) ) {

	const q = uv().sub( 0.5 ).mul( 2.0 );
	const r2 = dot( q, q );
	const nz = sqrt( max( float( 1 ).sub( r2 ), 0 ) );
	const fres = pow( float( 1 ).sub( nz ), 1.6 );
	const edge = float( 1 ).sub( smoothstep( 0.88, 1.0, r2 ) );
	const silver = mix( vec3( 0.04, 0.16, 0.22 ), vec3( 0.85, 0.97, 1.0 ), smoothstep( - 0.6, 0.7, q.y ) );
	const spec = pow( max( float( 1 ).sub( length( q.sub( vec2( - 0.3, 0.38 ) ) ).mul( 3.2 ) ), 0 ), 1.5 );
	const caust = pow( max( float( 1 ).sub( length( q.sub( vec2( 0.2, - 0.55 ) ).mul( vec2( 1.0, 2.5 ) ) ).mul( 2.2 ) ), 0 ), 2.0 ).mul( 0.5 );
	const light = lightTransmittance( positionWorld.y ).mul( 2.4 );
	mat.colorNode = silver.mul( fres ).add( vec3( spec.mul( 3.0 ).add( caust ) ) ).mul( light );
	mat.opacityNode = fres.mul( 1.2 ).add( spec ).add( caust ).add( 0.06 ).min( 1 ).mul( edge ).mul( fade );

}

// ---------- 从海底石缝升起的气泡 ----------
// 真实气泡：成簇间歇冒出、细小、沿轻微螺旋上升；
// 外观透明，只有边缘因全反射呈银亮色，顶部有高光
function createBubbles() {

	const STREAMS = 8;
	const BURSTS = 6; // 每个出气口同时在上升的气泡簇数
	const PER_BURST = 9;
	const rnd = mulberry32( 99 );
	const origins = [];
	for ( let i = 0; i < STREAMS; i ++ ) {

		const a = rnd() * Math.PI * 2, r = 9 + rnd() * 40;
		const x = Math.cos( a ) * r, z = Math.sin( a ) * r;
		origins.push( new THREE.Vector3( x, floorHeight( x, z ) + 0.2, z ) );

	}

	const originNode = uniformArray( origins, 'vec3' );
	const mat = new THREE.SpriteNodeMaterial( { transparent: true, depthWrite: false } );

	const id = instanceIndex;
	const stream = id.mod( STREAMS );
	const burst = id.div( STREAMS ).div( PER_BURST ); // 同一簇的气泡共享出发时间
	const burstSeed = hash( burst.mul( 131 ).add( stream.mul( 17 ) ) );
	const seed = hash( id.add( 777 ) );
	const origin = originNode.element( stream );
	const height = float( SURFACE_Y ).sub( origin.y );

	// 只保留细小气泡：尺寸在很小的范围内变化
	const size = pow( hash( id.add( 31 ) ), 3.0 );
	const radius = mix( float( 0.02 ), float( 0.055 ), size );
	const speed = mix( float( 1.2 ), float( 1.8 ), size ).mul( mix( 0.85, 1.15, hash( id.add( 53 ) ) ) );

	// 每个出气口按周期间歇喷出：一簇里的气泡相隔零点几秒依次冒出
	const period = height.div( 1.1 ).add( 4.0 );
	const clock = time.add( burstSeed.mul( 97.0 ) ).add( float( burst ).mul( period.div( BURSTS ) ) );
	const age = mod( clock, period ).sub( seed.mul( 0.9 ) );
	const rise = age.mul( speed );
	const alive = step( 0.0, age ).mul( step( rise, height ) );
	const k = clamp( rise.div( height ), 0, 1 );

	// 路径：近乎直线的轻微螺旋，整体随洋流略微偏移
	const swirl = size.mul( 0.12 ).add( 0.03 );
	const w = mix( float( 3.0 ), float( 5.5 ), seed );
	const path = vec3(
		sin( age.mul( w ).add( seed.mul( 40 ) ) ).mul( swirl ),
		0,
		cos( age.mul( w.mul( 0.8 ) ).add( seed.mul( 25 ) ) ).mul( swirl )
	);
	const spread = vec3( seed.sub( 0.5 ), 0, hash( id.add( 91 ) ).sub( 0.5 ) ).mul( 0.35 );
	const drift = vec3( 0.5, 0, 0.2 ).mul( rise.mul( 0.08 ) );
	const center = origin.add( vec3( 0, rise, 0 ) ).add( path ).add( spread ).add( drift );
	mat.positionNode = center;

	// 上升时水压减小而略微膨胀
	// 远处的小气泡保持约 2 像素的最小尺寸，呈现为闪烁的银点
	const camDist = length( center.sub( cameraPosition ) );
	const grow = max( radius.mul( k.mul( 0.35 ).add( 1.0 ) ).mul( 2.0 ), camDist.mul( 0.0035 ) ).mul( alive );
	mat.scaleNode = grow;

	applyBubbleShading( mat );

	const sprite = new THREE.Sprite( mat );
	sprite.userData.origins = origins;
	sprite.count = STREAMS * BURSTS * PER_BURST;
	sprite.frustumCulled = false;
	return sprite;

}

// ---------- 背景水体 ----------
function createBackdrop() {

	const mat = new THREE.MeshBasicNodeMaterial( { side: THREE.BackSide, fog: false, depthWrite: false } );
	mat.colorNode = waterColor( normalize( positionWorld.sub( cameraPosition ) ) );
	const mesh = new THREE.Mesh( new THREE.SphereGeometry( 900, 48, 24 ), mat );
	mesh.renderOrder = - 1;
	mesh.frustumCulled = false;
	return mesh;

}

// ---------- 用于金属鱼鳞反射的环境贴图 ----------
export function createEnvironmentScene() {

	const envScene = new THREE.Scene();
	const mat = new THREE.MeshBasicNodeMaterial( { side: THREE.BackSide } );
	const d = normalize( positionLocal );
	// 高反差：头顶明亮的斯涅尔窗 + 下方深暗的海水，让银色鱼鳞呈现真实的镜面明暗
	const snell = smoothstep( 0.64, 0.7, d.y );
	const sd = max( dot( d, sunDir ), 0 );
	// 水平方向也要足够亮：银鳞体侧主要反射的是水平方向的水体散射光，太暗就会发黑
	const horizon = mix( vec3( 0.03, 0.09, 0.12 ), vec3( 0.14, 0.38, 0.48 ), smoothstep( - 0.5, 0.3, d.y ) );
	mat.colorNode = horizon
		.add( vec3( 0.75, 0.93, 1.0 ).mul( snell ).mul( 3.2 ) )
		.add( vec3( 1.0, 0.95, 0.85 ).mul( pow( sd, 60 ).mul( 24 ) ) );
	envScene.add( new THREE.Mesh( new THREE.SphereGeometry( 50, 64, 32 ), mat ) );
	return envScene;

}

// underwater fog：按通道衰减 + 方向相关的散射色
export const underwaterFog = Fn( ( [ output ] ) => {

	const toFrag = positionWorld.sub( cameraPosition );
	const dist = length( toFrag );
	const dir = toFrag.div( dist );
	const T = exp( EXTINCTION.mul( dist ).negate() );
	return vec4( output.rgb.mul( T ).add( waterColor( dir ).mul( float( 1 ).sub( T ) ) ), output.a );

} );

export function mulberry32( a ) {

	return function () {

		let t = a += 0x6D2B79F5;
		t = Math.imul( t ^ t >>> 15, t | 1 );
		t ^= t + Math.imul( t ^ t >>> 7, t | 61 );
		return ( ( t ^ t >>> 14 ) >>> 0 ) / 4294967296;

	};

}

export function createEnvironment() {

	const group = new THREE.Group();
	const backdrop = createBackdrop();
	const bubbles = createBubbles();
	group.add( backdrop, createSeabed(), createRocks(), createKelp(), createSurface(), createMarineSnow(), bubbles );
	return { group, backdrop, bubbleOrigins: bubbles.userData.origins };

}
