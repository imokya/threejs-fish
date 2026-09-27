// 调节面板：实时调整画面参数，支持预设、复制参数，设置会记在本机浏览器里
import GUI from 'three/addons/libs/lil-gui.module.min.js';

const STORAGE_KEY = 'fish-school-settings-v1';

// 默认值 = 当前代码里的效果
export const DEFAULTS = {
	fishBrightness: 1.0,
	envIntensity: 1.25,
	ambient: 0.35,
	rays: 1.0,
	bloom: 0.5,
	dream: 1.0,
	density: 1.0,
	sunElevation: 55,
	exposure: 1.0,
	formation: 'auto',
	shot: 'auto',
	autoBurst: true,
	autoFlyby: true,
};

const PRESETS = {
	梦幻: { ...DEFAULTS },
	清透: { fishBrightness: 1.05, envIntensity: 1.3, ambient: 0.4, rays: 0.7, bloom: 0.35, dream: 0.3, density: 0.6, sunElevation: 62, exposure: 1.05 },
	深邃: { fishBrightness: 0.9, envIntensity: 1.1, ambient: 0.2, rays: 1.5, bloom: 0.55, dream: 0.6, density: 1.8, sunElevation: 48, exposure: 0.85 },
};

function load() {

	try {

		const saved = JSON.parse( localStorage.getItem( STORAGE_KEY ) || 'null' );
		return saved ? { ...DEFAULTS, ...saved } : { ...DEFAULTS };

	} catch {

		return { ...DEFAULTS };

	}

}

function save( params ) {

	try {

		localStorage.setItem( STORAGE_KEY, JSON.stringify( params ) );

	} catch { /* 隐私模式等情况下忽略 */ }

}

// apply(params)：把参数写入场景；actions：立即触发事件、切换鱼数等
export function createPanel( apply, actions, fishCount ) {

	const params = load();
	const gui = new GUI( { title: '画面调节（按 H 隐藏）' } );
	gui.close();

	const onChange = () => {

		apply( params );
		save( params );

	};

	const look = gui.addFolder( '光影与色调' );
	look.add( params, 'fishBrightness', 0.3, 2, 0.01 ).name( '鱼身亮度' ).onChange( onChange );
	look.add( params, 'envIntensity', 0.3, 3, 0.01 ).name( '鱼鳞反光' ).onChange( onChange );
	look.add( params, 'ambient', 0, 1.5, 0.01 ).name( '水下散射光' ).onChange( onChange );
	look.add( params, 'rays', 0, 3, 0.01 ).name( '光柱强度' ).onChange( onChange );
	look.add( params, 'bloom', 0, 1.5, 0.01 ).name( '柔光泛光' ).onChange( onChange );
	look.add( params, 'dream', 0, 1.5, 0.01 ).name( '梦幻程度' ).onChange( onChange );
	look.add( params, 'density', 0.3, 2.5, 0.01 ).name( '海水浑浊度' ).onChange( onChange );
	look.add( params, 'sunElevation', 30, 88, 1 ).name( '太阳高度 °' ).onChange( onChange );
	look.add( params, 'exposure', 0.4, 1.8, 0.01 ).name( '曝光' ).onChange( onChange );

	const motion = gui.addFolder( '鱼群与镜头' );
	motion.add( params, 'formation', { 自动轮换: 'auto', 鱼球: 'ball', 鱼龙卷: 'tornado', 环形鱼阵: 'ring', 分群: 'split' } ).name( '形态' ).onChange( onChange );
	motion.add( params, 'shot', { 自动轮换: 'auto', 远景环绕: 'orbit', 贴边滑过: 'glide', 侧逆光: 'backlit', 仰拍: 'low' } ).name( '镜头' ).onChange( onChange );
	motion.add( params, 'autoBurst' ).name( '自动受惊爆散' ).onChange( onChange );
	motion.add( params, 'autoFlyby' ).name( '自动鱼流擦镜' ).onChange( onChange );
	motion.add( actions, 'burstNow' ).name( '▶ 立即爆散' );
	motion.add( actions, 'flybyNow' ).name( '▶ 立即鱼流擦镜' );
	const countCtl = { count: fishCount };
	motion.add( countCtl, 'count', [ 2048, 3072, 4096, 6144, 8192, 12288 ] ).name( '鱼的数量（重新加载）' ).onChange( ( n ) => {

		const url = new URL( location.href );
		url.searchParams.set( 'n', n );
		location.href = url.toString();

	} );

	const presets = gui.addFolder( '预设' );
	for ( const name in PRESETS ) {

		presets.add( { [ name ]: () => {

			Object.assign( params, PRESETS[ name ] );
			gui.controllersRecursive().forEach( ( c ) => c.updateDisplay() );
			onChange();

		} }, name );

	}

	presets.add( { copy: () => {

		const text = JSON.stringify( params, null, 2 );
		navigator.clipboard?.writeText( text ).catch( () => {} );
		console.log( '当前参数：\n' + text );
		alert( '参数已复制到剪贴板：\n\n' + text );

	} }, 'copy' ).name( '📋 复制当前参数' );

	presets.add( { reset: () => {

		Object.assign( params, DEFAULTS );
		gui.controllersRecursive().forEach( ( c ) => c.updateDisplay() );
		onChange();

	} }, 'reset' ).name( '↺ 恢复默认' );

	window.addEventListener( 'keydown', ( e ) => {

		if ( e.key === 'h' || e.key === 'H' ) gui.show( gui._hidden );

	} );

	apply( params );
	return { params, gui };

}
