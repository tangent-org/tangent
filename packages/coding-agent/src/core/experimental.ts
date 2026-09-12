export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.TANGENT_EXPERIMENTAL === "1";
}
