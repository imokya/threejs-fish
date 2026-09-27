// GPU 鱼群模拟（Boids）
// 邻居搜索使用 GPU 空间网格（计数排序）：每帧把鱼按位置分进格子，每条鱼只检查相邻 27 个格子
// 行为：分离 / 对齐 / 聚合 + 多种群体形态（鱼球、鱼龙卷、环形鱼阵、分群）+ 指针驱散 + 恐慌传播
import { Vector3 } from 'three/webgpu';
import {
	Fn, If, Loop, instancedArray, instanceIndex, invocationLocalIndex, workgroupArray, workgroupBarrier,
	atomicAdd, atomicLoad, atomicStore, uniform, uint, int, float, vec3, vec4, ivec3, hash,
	max, min, clamp, floor, length, normalize, cross, dot, exp, smoothstep, select,
} from 'three/tsl';
import { SURFACE_Y, FLOOR_Y } from './ocean.js';
import { pointer } from './pointer.js';

// 网格：格子边长 = 最大邻域半径，这样 3x3x3 个格子即可覆盖全部邻居
const CELL = 3.6;
const GRID_MIN = new Vector3( - 100, FLOOR_Y - 6, - 100 );
const GX = Math.ceil( 200 / CELL );
const GY = Math.ceil( ( SURFACE_Y - FLOOR_Y + 12 ) / CELL );
const GZ = GX;
const NUM_CELLS = GX * GY * GZ;
// 每个格子最多参考的邻居数（极密处限流，也更接近真实鱼只关注最近若干同伴的习性）
const MAX_PER_CELL = 36;
const SCAN_THREADS = 256;

export function createBoids( count ) {

	const posArray = new Float32Array( count * 4 );
	const velArray = new Float32Array( count * 4 );

	// 初始时鱼零散地分布在整片水域，随后逐渐汇聚成群
	for ( let i = 0; i < count; i ++ ) {

		const r = 25 + Math.random() * 35;
		const a = Math.random() * Math.PI * 2;
		posArray[ i * 4 + 0 ] = Math.cos( a ) * r;
		posArray[ i * 4 + 1 ] = FLOOR_Y + 6 + Math.random() * ( SURFACE_Y - FLOOR_Y - 12 );
		posArray[ i * 4 + 2 ] = Math.sin( a ) * r;
		posArray[ i * 4 + 3 ] = Math.random() * 100; // 摆尾相位

		const v = new Vector3( Math.random() - 0.5, ( Math.random() - 0.5 ) * 0.2, Math.random() - 0.5 ).normalize().multiplyScalar( 4 );
		velArray[ i * 4 + 0 ] = v.x;
		velArray[ i * 4 + 1 ] = v.y;
		velArray[ i * 4 + 2 ] = v.z;
		velArray[ i * 4 + 3 ] = 0; // 恐慌值

	}

	const positions = instancedArray( posArray, 'vec4' ); // xyz 位置, w 摆尾相位
	const velocities = instancedArray( velArray, 'vec4' ); // xyz 速度, w 恐慌值
	const banks = instancedArray( count, 'float' ); // 转弯侧倾角（平滑后）
	const sortedPos = instancedArray( count, 'vec4' );
	const sortedVel = instancedArray( count, 'vec4' );
	const fishCell = instancedArray( count, 'uint' );
	const fishSlot = instancedArray( count, 'uint' );
	const cellCount = instancedArray( NUM_CELLS, 'uint' ).toAtomic();
	const cellStart = instancedArray( NUM_CELLS, 'uint' );

	const u = {
		delta: uniform( 0 ),
		target: uniform( new Vector3() ),
		rayOrigin: pointer.origin,
		rayDir: pointer.dir,
		pointerActive: pointer.active,
		pointerRadius: uniform( 6.5 ),
		burst: uniform( 0 ),
		burstPoint: uniform( new Vector3() ),
		cameraPos: uniform( new Vector3() ),
		separation: uniform( 1.15 ),
		alignment: uniform( 3.0 ),
		cohesion: uniform( CELL ),
		minSpeed: uniform( 2.6 ),
		maxSpeed: uniform( 6.2 ),
		panicSpeed: uniform( 17 ),
		// 群体形态权重（由 CPU 端平滑过渡）
		wBall: uniform( 1 ),
		wTornado: uniform( 0 ),
		wRing: uniform( 0 ),
		wSplit: uniform( 0 ),
		splitOffset: uniform( new Vector3( 12, 0, 0 ) ),
	};

	// ---------- 网格工具 ----------
	const cellCoord = ( p ) => clamp(
		ivec3( floor( p.sub( vec3( GRID_MIN.x, GRID_MIN.y, GRID_MIN.z ) ).div( CELL ) ) ),
		ivec3( 0, 0, 0 ),
		ivec3( GX - 1, GY - 1, GZ - 1 )
	);
	const cellIndex = ( c ) => uint( c.x.add( c.y.mul( GX ) ).add( c.z.mul( GX * GY ) ) );

	// 1. 清空格子计数
	const clearCells = Fn( () => {

		atomicStore( cellCount.element( instanceIndex ), uint( 0 ) );

	} )().compute( NUM_CELLS );

	// 2. 每条鱼登记所在格子，并取得格内序号
	const assignCells = Fn( () => {

		const c = cellIndex( cellCoord( positions.element( instanceIndex ).xyz ) ).toVar();
		fishCell.element( instanceIndex ).assign( c );
		fishSlot.element( instanceIndex ).assign( atomicAdd( cellCount.element( c ), uint( 1 ) ) );

	} )().compute( count );

	// 3. 前缀和：单个工作组，每个线程负责一段连续的格子
	const partial = workgroupArray( 'uint', SCAN_THREADS );
	const CHUNK = Math.ceil( NUM_CELLS / SCAN_THREADS );
	const scanCells = Fn( () => {

		const t = invocationLocalIndex;
		const begin = t.mul( CHUNK ).toVar();
		const end = min( begin.add( CHUNK ), uint( NUM_CELLS ) ).toVar();

		const sum = uint( 0 ).toVar();
		Loop( { start: begin, end, type: 'uint', condition: '<', name: 'c' }, ( { c } ) => {

			sum.addAssign( atomicLoad( cellCount.element( c ) ) );

		} );

		partial.element( t ).assign( sum );
		workgroupBarrier();

		const offset = uint( 0 ).toVar();
		Loop( { start: uint( 0 ), end: t, type: 'uint', condition: '<', name: 'k' }, ( { k } ) => {

			offset.addAssign( partial.element( k ) );

		} );

		Loop( { start: begin, end, type: 'uint', condition: '<', name: 'c2' }, ( { c2 } ) => {

			cellStart.element( c2 ).assign( offset );
			offset.addAssign( atomicLoad( cellCount.element( c2 ) ) );

		} );

	} )().compute( SCAN_THREADS, [ SCAN_THREADS ] );

	// 4. 按格子顺序重排，邻居在显存中连续存放
	const scatter = Fn( () => {

		const dst = cellStart.element( fishCell.element( instanceIndex ) ).add( fishSlot.element( instanceIndex ) );
		sortedPos.element( dst ).assign( positions.element( instanceIndex ) );
		sortedVel.element( dst ).assign( velocities.element( instanceIndex ) );

	} )().compute( count );

	// ---------- 5. 行为更新 ----------
	const update = Fn( () => {

		const P = positions.element( instanceIndex );
		const V = velocities.element( instanceIndex );

		const pos = P.xyz.toVar();
		const vel = V.xyz.toVar();
		const panic = V.w.toVar();
		const dt = u.delta;

		const sepR2 = u.separation.mul( u.separation );
		const aliR2 = u.alignment.mul( u.alignment );
		const cohR2 = u.cohesion.mul( u.cohesion );

		const sep = vec3( 0 ).toVar();
		const ali = vec3( 0 ).toVar();
		const coh = vec3( 0 ).toVar();
		const nAli = float( 0 ).toVar();
		const nCoh = float( 0 ).toVar();
		const nPanic = float( 0 ).toVar();

		const base = cellCoord( pos ).toVar();

		Loop( { start: int( - 1 ), end: int( 2 ), type: 'int', condition: '<', name: 'oz' }, ( { oz } ) => {

			Loop( { start: int( - 1 ), end: int( 2 ), type: 'int', condition: '<', name: 'oy' }, ( { oy } ) => {

				Loop( { start: int( - 1 ), end: int( 2 ), type: 'int', condition: '<', name: 'ox' }, ( { ox } ) => {

					const cc = base.add( ivec3( ox, oy, oz ) ).toVar();
					const inside = cc.x.greaterThanEqual( 0 ).and( cc.x.lessThan( GX ) )
						.and( cc.y.greaterThanEqual( 0 ) ).and( cc.y.lessThan( GY ) )
						.and( cc.z.greaterThanEqual( 0 ) ).and( cc.z.lessThan( GZ ) );

					If( inside, () => {

						const ci = cellIndex( cc ).toVar();
						const start = cellStart.element( ci ).toVar();
						const n = min( atomicLoad( cellCount.element( ci ) ), uint( MAX_PER_CELL ) ).toVar();

						Loop( { start, end: start.add( n ), type: 'uint', condition: '<', name: 'j' }, ( { j } ) => {

							const op = sortedPos.element( j ).xyz;
							const d = op.sub( pos );
							const d2 = dot( d, d );

							// d2 > 0 排除自己
							If( d2.lessThan( cohR2 ).and( d2.greaterThan( 1e-6 ) ), () => {

								coh.addAssign( op );
								nCoh.addAssign( 1 );

								If( d2.lessThan( aliR2 ), () => {

									const ov = sortedVel.element( j );
									ali.addAssign( ov.xyz );
									nAli.addAssign( 1 );
									nPanic.assign( max( nPanic, ov.w ) );

									If( d2.lessThan( sepR2 ), () => {

										sep.subAssign( d.div( d2.add( 0.05 ) ) );

									} );

								} );

							} );

						} );

					} );

				} );

			} );

		} );

		const acc = vec3( 0 ).toVar();
		const calm = float( 1 ).sub( panic.mul( 0.7 ) );

		If( nAli.greaterThan( 0 ), () => {

			acc.addAssign( ali.div( nAli ).sub( vel ).mul( 1.35 ) );

		} );

		If( nCoh.greaterThan( 0 ), () => {

			acc.addAssign( coh.div( nCoh ).sub( pos ).mul( 0.9 ).mul( calm ) );

		} );

		acc.addAssign( sep.mul( 5.5 ) );

		// ---------- 群体形态 ----------
		const up = vec3( 0, 1, 0 );
		const toT = u.target.sub( pos );
		const dT = length( toT ).max( 0.001 );
		const flatT = vec3( toT.x, 0, toT.z ).add( vec3( 0.001, 0, 0 ) );
		const rT = length( flatT );
		const swirlDir = normalize( cross( up, flatT ) );

		// 鱼球：向中心聚拢 + 水平环游
		const ball = toT.div( dT ).mul( float( 0.9 ).add( smoothstep( 4, 24, dT ).mul( 5.0 ) ) )
			.add( swirlDir.mul( smoothstep( 1, 9, dT ).mul( 1.6 ) ) );

		// 鱼龙卷：绕竖直轴高速旋转的中空柱体，上下延展
		const dy = pos.y.sub( u.target.y );
		const tornado = flatT.div( rT ).mul( rT.sub( 5.5 ).mul( 0.9 ) )
			.add( vec3( 0, dy.sub( clamp( dy, - 10, 10 ) ).mul( - 1.2 ), 0 ) )
			.add( swirlDir.mul( 3.6 ) )
			.add( vec3( 0, float( 0.5 ).sub( hash( instanceIndex ) ).mul( 1.4 ), 0 ) );

		// 环形鱼阵：沿水平圆环首尾相接地巡游
		const ringR = float( 15 );
		const toRing = flatT.div( rT ).mul( rT.sub( ringR ) ).add( vec3( 0, dy.negate(), 0 ) );
		const ring = toRing.mul( 0.7 ).add( swirlDir.mul( 2.8 ) );

		// 分群：按编号奇偶分成两群，各自成球
		const side = select( instanceIndex.mod( 2 ).equal( 0 ), float( 1 ), float( - 1 ) );
		const toS = u.target.add( u.splitOffset.mul( side ) ).sub( pos );
		const dS = length( toS ).max( 0.001 );
		const flatS = vec3( toS.x, 0, toS.z ).add( vec3( 0.001, 0, 0 ) );
		const split = toS.div( dS ).mul( float( 0.9 ).add( smoothstep( 3, 18, dS ).mul( 5.0 ) ) )
			.add( normalize( cross( up, flatS ) ).mul( side ).mul( smoothstep( 1, 7, dS ).mul( 1.6 ) ) );

		acc.addAssign(
			ball.mul( u.wBall ).add( tornado.mul( u.wTornado ) ).add( ring.mul( u.wRing ) ).add( split.mul( u.wSplit ) ).mul( calm )
		);

		// 边界：水面、海底、水平范围
		const top = float( SURFACE_Y - 5 );
		const bottom = float( FLOOR_Y + 5 );
		acc.y.subAssign( max( pos.y.sub( top ), 0 ).mul( 4.0 ) );
		acc.y.addAssign( max( bottom.sub( pos.y ), 0 ).mul( 4.0 ) );
		const rXZ = length( pos.xz );
		acc.subAssign( vec3( pos.x, 0, pos.z ).div( rXZ.max( 0.001 ) ).mul( max( rXZ.sub( 55 ), 0 ).mul( 2.0 ) ) );

		// 鱼更倾向于水平游动（鱼龙卷形态下允许更多上下游动）
		acc.y.subAssign( vel.y.mul( float( 0.9 ).sub( u.wTornado.mul( 0.6 ) ) ) );

		// 指针射线驱散
		const rel = pos.sub( u.rayOrigin );
		const tp = max( dot( rel, u.rayDir ), 0 );
		const away = rel.sub( u.rayDir.mul( tp ) );
		const dR = length( away ).max( 0.001 );
		const fR = clamp( float( 1 ).sub( dR.div( u.pointerRadius ) ), 0, 1 ).mul( u.pointerActive );
		acc.addAssign( away.div( dR ).mul( fR.mul( fR ).mul( 140 ) ) );

		// 鱼会自然地避开镜头（像避开潜水员一样），不至于穿过相机
		const relC = pos.sub( u.cameraPos );
		const dC = length( relC ).max( 0.001 );
		acc.addAssign( relC.div( dC ).mul( clamp( float( 1 ).sub( dC.div( 5 ) ), 0, 1 ).mul( 40 ) ) );

		// 点击冲击波
		const relB = pos.sub( u.burstPoint );
		const dB = length( relB ).max( 0.001 );
		const fB = clamp( float( 1 ).sub( dB.div( 16 ) ), 0, 1 ).mul( u.burst );
		acc.addAssign( relB.div( dB ).mul( fB.mul( 260 ) ) );

		// 恐慌：自身受惊 + 从邻居处传播（形成"闪电式"扩散波）
		panic.assign( panic.mul( exp( dt.mul( - 1.1 ) ) ) );
		panic.assign( max( panic, max( fR.mul( 1.4 ), fB ).min( 1 ) ) );
		panic.assign( max( panic, nPanic.mul( 0.82 ) ) );

		// 转弯侧倾：横向加速度越大，身体向转弯内侧倾斜越多（平滑过渡）
		const fwd0 = vel.div( length( vel ).max( 0.0001 ) );
		const right0 = normalize( cross( vec3( 0, 1, 0 ), fwd0 ).add( vec3( 0.0001, 0, 0 ) ) );
		const bankTarget = clamp( dot( acc, right0 ).mul( - 0.06 ), - 0.3, 0.3 );
		const B = banks.element( instanceIndex );
		B.assign( B.add( bankTarget.sub( B ).mul( float( 1 ).sub( exp( dt.mul( - 3.5 ) ) ) ) ) );

		vel.addAssign( acc.mul( dt ) );

		const speed = length( vel ).max( 0.0001 );
		const maxS = u.maxSpeed.add( u.panicSpeed.sub( u.maxSpeed ).mul( panic ) );
		const clamped = clamp( speed, u.minSpeed, maxS );
		vel.assign( vel.div( speed ).mul( clamped ) );

		pos.addAssign( vel.mul( dt ) );

		// 摆尾频率随速度加快
		const phase = P.w.add( dt.mul( clamped.mul( 2.6 ).add( 3.0 ) ) ).mod( 628.3185 );

		P.assign( vec4( pos, phase ) );
		V.assign( vec4( vel, panic ) );

	} )().compute( count );

	return {
		positions, velocities, banks, uniforms: u,
		update: [ clearCells, assignCells, scanCells, scatter, update ],
	};

}
