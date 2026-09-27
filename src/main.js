import * as THREE from 'three/webgpu';
import { output } from 'three/tsl';
import { createBoids } from './boids.js';
import { createFormationDirector, createCameraDirector } from './choreography.js';
import { createFish } from './fish.js';
import { createEnvironment, createEnvironmentScene, underwaterFog } from './environment.js';
import { createPipeline } from './post.js';
import { SUN_DIR, SURFACE_Y, cloudTime, cloudShadeJS } from './ocean.js';

const msg = document.getElementById( 'msg' );
const hud = document.getElementById( 'hud' );
const info = document.getElementById( 'info' );

const params = new URLSearchParams( location.search );
const isMobile = matchMedia( '(pointer: coarse)' ).matches;
const FISH_COUNT = Math.min( 32768, Math.max( 256, parseInt( params.get( 'n' ) ) || ( isMobile ? 3072 : 6144 ) ) );

async function main() {

	if ( ! navigator.gpu ) {

		msg.innerHTML = '当前浏览器不支持 WebGPU<br><span style="opacity:.6;font-size:13px">请使用最新版 Chrome / Edge / Safari 18+ 打开</span>';
		return;

	}

	const renderer = new THREE.WebGPURenderer( { antialias: true } );
	renderer.setPixelRatio( Math.min( window.devicePixelRatio, isMobile ? 1.25 : 1.5 ) );
	renderer.setSize( window.innerWidth, window.innerHeight );
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1.0;
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = THREE.PCFShadowMap;
	document.body.appendChild( renderer.domElement );
	await renderer.init();

	if ( renderer.backend.isWebGPUBackend !== true ) {

		msg.innerHTML = '未能初始化 WebGPU 设备<br><span style="opacity:.6;font-size:13px">请确认浏览器已启用硬件加速</span>';
		return;

	}

	const scene = new THREE.Scene();
	scene.fogNode = underwaterFog( output );

	const camera = new THREE.PerspectiveCamera( 55, window.innerWidth / window.innerHeight, 0.1, 2000 );
	camera.position.set( 0, 0, 40 );

	// 环境反射（给银色鱼鳞提供明亮的顶光反射）
	const pmrem = new THREE.PMREMGenerator( renderer );
	scene.environment = pmrem.fromScene( createEnvironmentScene(), 0.04 ).texture;
	scene.environmentIntensity = 1.25;

	// 太阳光（已考虑折射后的角度），投射鱼群阴影
	const sun = new THREE.DirectionalLight( 0xeafcff, 5.0 );
	sun.castShadow = true;
	sun.shadow.mapSize.set( 2048, 2048 );
	const sc = sun.shadow.camera;
	sc.left = - 60; sc.right = 60; sc.top = 60; sc.bottom = - 60; sc.near = 1; sc.far = 160;
	sun.shadow.bias = - 0.0004;
	sun.shadow.normalBias = 0.03;
	sun.shadow.radius = 3;
	// 阴影强度减半：鱼群保留内外明暗层次，但不会整团发暗
	sun.shadow.intensity = 0.35;
	scene.add( sun, sun.target );

	// 水下四周的散射光：给鱼身一个稳定的漫反射底亮度，近看不会只靠镜面反射而发黑
	const ambient = new THREE.HemisphereLight( 0x9fdcea, 0x0b2c36, 0.35 );
	scene.add( ambient );

	const env = createEnvironment();
	scene.add( env.group );

	const boids = createBoids( FISH_COUNT );
	const fish = createFish( boids, FISH_COUNT );
	scene.add( fish );

	const post = createPipeline( renderer, scene, camera, sun );
	if ( params.has( 'debug' ) ) window.__debug = { renderer, boids };

	// ---------- 交互 ----------
	const ndc = new THREE.Vector2( 10, 10 );
	const raycaster = new THREE.Raycaster();
	let pointerActive = 0;
	let isTouch = false;
	const u = boids.uniforms;

	const setPointer = ( e ) => {

		ndc.set( ( e.clientX / window.innerWidth ) * 2 - 1, - ( e.clientY / window.innerHeight ) * 2 + 1 );

	};

	renderer.domElement.addEventListener( 'pointermove', ( e ) => {

		isTouch = e.pointerType !== 'mouse';
		setPointer( e );
		if ( ! isTouch || e.buttons ) pointerActive = 1;

	} );

	renderer.domElement.addEventListener( 'pointerdown', ( e ) => {

		isTouch = e.pointerType !== 'mouse';
		setPointer( e );
		pointerActive = 1;
		raycaster.setFromCamera( ndc, camera );
		// 冲击点取射线上离鱼群中心最近的位置
		const ray = raycaster.ray;
		const t = Math.max( 4, ray.direction.dot( u.target.value.clone().sub( ray.origin ) ) );
		u.burstPoint.value.copy( ray.origin ).addScaledVector( ray.direction, t );
		u.burst.value = 1;

	} );

	const release = ( e ) => {

		if ( e.type === 'pointerleave' || e.pointerType !== 'mouse' ) pointerActive = 0;

	};

	renderer.domElement.addEventListener( 'pointerup', release );
	renderer.domElement.addEventListener( 'pointercancel', release );
	renderer.domElement.addEventListener( 'pointerleave', release );

	let zoom = 1;
	window.addEventListener( 'wheel', ( e ) => {

		zoom = THREE.MathUtils.clamp( zoom * Math.exp( e.deltaY * 0.001 ), 0.45, 1.6 );

	}, { passive: true } );

	window.addEventListener( 'resize', () => {

		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();
		renderer.setSize( window.innerWidth, window.innerHeight );

	} );

	// ---------- 动画 ----------
	const timer = new THREE.Timer();
	timer.connect( document );
	const smoothNdc = new THREE.Vector2();
	const formations = createFormationDirector( u );
	// ?shot=backlit 等参数可固定某个镜头，便于单独查看
	const director = createCameraDirector( camera, params.get( 'shot' ) );
	let elapsed = 0;
	let started = false;

	renderer.setAnimationLoop( () => {

		// 页面不可见时（切到后台、预览面板被隐藏）跳过渲染，避免对 0 尺寸画布提交绘制
		if ( document.hidden ) return;

		timer.update();
		const dt = Math.min( timer.getDelta(), 1 / 30 );
		elapsed += dt;
		const t = elapsed;

		// 汇聚目标沿舒缓的利萨如轨迹游移
		u.target.value.set(
			Math.sin( t * 0.071 ) * 16,
			1.5 + Math.sin( t * 0.113 ) * 5,
			Math.sin( t * 0.053 + 1.3 ) * 13
		);

		formations( dt, t );

		// 相机：几种镜头缓慢轮换，随指针轻微视差
		if ( Math.abs( ndc.x ) <= 1 ) smoothNdc.lerp( ndc, 1 - Math.exp( - dt * 1.5 ) );
		const shot = director( dt, t, u.target.value, zoom, smoothNdc );
		const lookAt = shot.lookAt;
		renderer.toneMappingExposure = shot.exposure;

		env.backdrop.position.copy( camera.position );
		sun.target.position.copy( lookAt );
		sun.position.copy( lookAt ).addScaledVector( SUN_DIR, 80 );

		// 云影：阳光强度随鱼群上方的云层缓慢起伏
		cloudTime.value = t;
		const proj = ( SURFACE_Y - lookAt.y ) / SUN_DIR.y;
		const shade = cloudShadeJS( lookAt.x + SUN_DIR.x * proj, lookAt.z + SUN_DIR.z * proj, t );
		sun.intensity = 5.0 * ( 0.52 + 0.48 * shade );

		// 指针射线
		raycaster.setFromCamera( ndc, camera );
		u.rayOrigin.value.copy( raycaster.ray.origin );
		u.rayDir.value.copy( raycaster.ray.direction );
		u.pointerActive.value += ( pointerActive - u.pointerActive.value ) * ( 1 - Math.exp( - dt * 10 ) );
		u.burst.value *= Math.exp( - dt * 5 );

		u.delta.value = dt;

		u.cameraPos.value.copy( camera.position );

		renderer.compute( boids.update );
		post.render();

		if ( ! started ) {

			started = true;
			msg.style.display = 'none';
			hud.style.opacity = 1;
			info.textContent = `${FISH_COUNT} 条鱼 · WebGPU 计算着色器`;

		}

	} );

}

main().catch( ( err ) => {

	console.error( err );
	msg.textContent = '初始化失败：' + err.message;

} );
