import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Signed with Day Board's key (app/release.p12, see app/build.gradle.kts), so
// both apps come from the same publisher. Without the secret the build is
// debug-signed.
val keystoreFile = file("../app/release.p12")
val keystorePassword: String? = System.getenv("DAYBOARD_KEYSTORE_PASSWORD")?.takeIf { it.isNotBlank() && keystoreFile.exists() }
val buildNumber = (findProperty("versionCode") as String?)?.toIntOrNull() ?: 1

android {
    namespace = "com.braachgs.matchboard"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.braachgs.matchboard"
        minSdk = 26
        targetSdk = 34
        versionCode = buildNumber
        versionName = "1.$buildNumber"
    }

    signingConfigs {
        if (keystorePassword != null) {
            create("release") {
                storeFile = keystoreFile
                storeType = "pkcs12"
                storePassword = keystorePassword
                keyAlias = "dayboard"
                keyPassword = keystorePassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    implementation("dayboard:core:1.0")
    // Refreshes every 15 minutes, surviving reboots and Doze.
    implementation("androidx.work:work-runtime:2.9.1")
}
