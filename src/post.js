// 后期：带体积阴影的光柱（光线步进 + 前向散射相函数）、色差、泛光、调色、暗角
import * as THREE from 'three/webgpu';
import {
	Fn, Loop, pass, rtt, uniform, screenSize, texture, renderOutput, screenUV, screenCoordinate, getViewPosition,
	interleavedGradientNoise, mx_noise_float, time, sin, cos, vec2, vec3, vec4, float, min, max, exp, dot, pow, length, smoothstep, mix, step,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { SURFACE_Y, EXTINCTION, sunDir, shaftPattern } from './ocean.js';

export function createPipeline( renderer, scene, camera, sun ) {

	const scenePass = pass( scene, camera );
	const sceneColor = scenePass.getTextureNode( 'output' );
	const viewZ = scenePass.getViewZNode();

	const uProjInv = uniform( camera.projectionMatrixInverse );
	const uCamWorld = uniform( camera.matrixWorld );
	const uCamPos = uniform( camera.position );
	const uShadowMatrix = uniform( sun.shadow.matrix );
	const rayStrength = uniform( 1.0 );

	const STEPS = 26;
	const MAX_DIST = 120;

	// 更柔、更宽的泛光：水面、光柱和亮鳞周围泛起一层柔光
	const bloomPass = bloom( sceneColor, 0.5, 0.85, 0.95 );

	// 阴影贴图在首帧渲染后才会创建，所以体积阴影延迟构建
	const buildOutput = ( shadowDepth ) => {

		// 该点是否被阳光照到（鱼群、礁石、海藻会在光柱中投下体积阴影）
		const sunVisibility = ( p ) => {

			if ( ! shadowDepth ) return float( 1 );
			const sc = uShadowMatrix.mul( vec4( p, 1 ) );
			const c = sc.xyz.div( sc.w );
			const suv = vec2( c.x, c.y.oneMinus() );
			const lit = texture( shadowDepth, suv ).compare( c.z.sub( 0.001 ) );
			const inside = step( 0.001, suv.x ).mul( step( suv.x, 0.999 ) ).mul( step( 0.001, suv.y ) ).mul( step( suv.y, 0.999 ) );
			// 体积阴影只保留约一半强度，避免鱼群身后的水体发沉
			return mix( float( 1 ), lit, inside.mul( 0.5 ) );

		};

		const godRays = ( dirView, dist ) => {

			const maxD = min( dist, MAX_DIST );
			const dirW = uCamWorld.mul( vec4( dirView, 0 ) ).xyz.normalize().toVar();
			const stepLen = maxD.div( STEPS ).toVar();
			const jitter = interleavedGradientNoise( screenCoordinate );
			const acc = vec3( 0 ).toVar();

			Loop( STEPS, ( { i } ) => {

				const t = float( i ).add( jitter ).mul( stepLen );
				const p = uCamPos.add( dirW.mul( t ) ).toVar();
				const depth = max( float( SURFACE_Y ).sub( p.y ), 0 );
				const q = p.xz.add( sunDir.xz.mul( depth.div( sunDir.y ) ) );
				const s = shaftPattern( q, depth );
				const atten = exp( EXTINCTION.mul( depth.div( sunDir.y ).add( t ) ).negate() );
				const vis = sunVisibility( p );
				acc.addAssign( atten.mul( s.mul( vis ) ).mul( step( p.y, SURFACE_Y ) ) );

			} );

			// Henyey-Greenstein 前向散射：迎着阳光看时光柱最亮
			const g = 0.5;
			const cosT = dot( dirW, sunDir );
			const hg = float( 1 - g * g ).div( pow( float( 1 + g * g ).sub( cosT.mul( 2 * g ) ), 1.5 ) ).mul( 1 / ( 4 * Math.PI ) );
			return acc.mul( stepLen ).mul( hg.add( 0.015 ) ).mul( vec3( 0.5, 0.9, 0.95 ) ).mul( 0.46 ).mul( rayStrength );

		};

		// 体积光在半分辨率下计算，再双线性上采样（顺便柔化步进抖动噪点）
		const raysTex = rtt( Fn( () => {

			const dirView = getViewPosition( screenUV, float( 0.5 ), uProjInv ).normalize().toVar();
			const dist = viewZ.div( dirView.z );
			return vec4( godRays( dirView, dist ), 1 );

		} )(), null, null, { resolutionScale: 0.5 } );

		return Fn( () => {

			const dirView = getViewPosition( screenUV, float( 0.5 ), uProjInv ).normalize().toVar();
			const dist = viewZ.div( dirView.z ).toVar();
			const far = smoothstep( 14.0, 95.0, dist );

			// 极轻微的水波晃动，越远越明显（幅度控制在 1~2 像素内，避免重影）
			const t = time;
			const wuv = screenUV.mul( vec2( 1.0, 0.75 ) );
			const flow = vec2(
				mx_noise_float( vec3( wuv.mul( 5.0 ), t.mul( 0.45 ) ) ).add( sin( wuv.y.mul( 38.0 ).add( t.mul( 1.6 ) ) ).mul( 0.1 ) ),
				mx_noise_float( vec3( wuv.mul( 5.0 ).add( 9.1 ), t.mul( 0.45 ) ) ).add( cos( wuv.x.mul( 31.0 ).sub( t.mul( 1.3 ) ) ).mul( 0.1 ) )
			);
			const duv = screenUV.add( flow.mul( mix( float( 0.0003 ), float( 0.0014 ), far ) ) ).toVar();

			const off = screenUV.sub( 0.5 );
			const base = sceneColor.sample( duv ).rgb;

			// 4 点采样上采样体积光，抹掉半分辨率抖动带来的网格纹
			const px = vec2( 1.5 ).div( screenSize );
			const rays = raysTex.sample( screenUV.add( px.mul( vec2( 1, 1 ) ) ) ).rgb
				.add( raysTex.sample( screenUV.add( px.mul( vec2( - 1, 1 ) ) ) ).rgb )
				.add( raysTex.sample( screenUV.add( px.mul( vec2( 1, - 1 ) ) ) ).rgb )
				.add( raysTex.sample( screenUV.add( px.mul( vec2( - 1, - 1 ) ) ) ).rgb ).mul( 0.25 );

			const hdr = base.add( rays ).add( bloomPass.rgb ).toVar();
			// 饱和度
			const luma = dot( hdr, vec3( 0.2126, 0.7152, 0.0722 ) );
			hdr.assign( max( mix( vec3( luma ), hdr, 1.08 ), 0 ) );

			// 色调映射后再做对比度与暗角（显示空间）
			const ldr = renderOutput( vec4( hdr, 1 ) ).rgb.toVar();
			// 梦幻调色：放缓对比、暗部偏深青蓝、亮部带奶油暖色、黑位微抬形成柔和的哑光质感
			ldr.assign( mix( ldr, ldr.mul( ldr ).mul( ldr.mul( - 2 ).add( 3 ) ), 0.12 ) );
			const l = dot( ldr, vec3( 0.2126, 0.7152, 0.0722 ) );
			ldr.addAssign( vec3( 0.0, 0.035, 0.06 ).mul( float( 1 ).sub( l ).mul( float( 1 ).sub( l ) ) ) );
			ldr.assign( mix( ldr, ldr.mul( vec3( 1.05, 1.0, 0.92 ) ), smoothstep( 0.6, 1.0, l ).mul( 0.35 ) ) );
			ldr.assign( ldr.mul( 0.97 ).add( vec3( 0.005, 0.014, 0.018 ) ) );
			const v = length( off.mul( vec2( 1.2, 1.0 ) ) );
			ldr.mulAssign( mix( float( 1 ), float( 0.45 ), smoothstep( 0.35, 0.95, v ) ) );
			return vec4( ldr, 1 );

		} )();

	};

	const pipeline = new THREE.RenderPipeline( renderer, buildOutput( null ) );
	pipeline.outputColorTransform = false;

	let volumetricShadows = false;

	const render = () => {

		pipeline.render();

		if ( ! volumetricShadows && sun.shadow.map && sun.shadow.map.depthTexture ) {

			volumetricShadows = true;
			pipeline.outputNode = buildOutput( sun.shadow.map.depthTexture );
			pipeline.needsUpdate = true;

		}

	};

	return { pipeline, render, rayStrength };

}
