import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release builds are signed with app/release.p12, which the GitHub workflow
// creates on its first signed run, encrypted with the DAYBOARD_KEYSTORE_PASSWORD
// secret (that secret is the only place the password exists). Without both,
// the build is debug-signed and can't update an installed release build.
val keystoreFile = file("release.p12")
val keystorePassword: String? = System.getenv("DAYBOARD_KEYSTORE_PASSWORD")?.takeIf { it.isNotBlank() && keystoreFile.exists() }
val buildNumber = (findProperty("versionCode") as String?)?.toIntOrNull() ?: 1

android {
    namespace = "com.braachgs.dayboard"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.braachgs.dayboard"
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
}
